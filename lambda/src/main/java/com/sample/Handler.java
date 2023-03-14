/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

package com.sample;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.LambdaLogger;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.events.S3Event;
import com.amazonaws.services.lambda.runtime.events.SQSBatchResponse;
import com.amazonaws.services.lambda.runtime.events.SQSEvent;
import com.amazonaws.services.lambda.runtime.events.models.s3.S3EventNotification.S3Entity;
import com.google.gson.*;
import lombok.AllArgsConstructor;
import lombok.NonNull;
import lombok.val;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.openssl.PEMParser;
import org.joda.time.DateTime;
import software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider;
import software.amazon.awssdk.awscore.exception.AwsServiceException;
import software.amazon.awssdk.core.exception.SdkClientException;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.acmpca.AcmPcaClient;
import software.amazon.awssdk.services.acmpca.model.*;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.NoSuchBucketException;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.utils.Pair;

import java.io.IOException;
import java.io.StringReader;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Period;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * This is the handler class for Lambda Function which is triggered when new .csr files are uploaded to the input S3 bucket. This handler
 * gets the submitted CSRs signed with the requested PAI (its ARN is part of the S3 key) and uploads resulting certificates to the output
 * S3 bucket (see {@link Handler#handleRequest(SQSEvent, Context)}).
 */
@AllArgsConstructor
public class Handler implements RequestHandler<SQSEvent, SQSBatchResponse>{

  private static final String DEFAULT_VALIDITY = "1865";

  private final JsonDeserializer<org.joda.time.DateTime> dateTimeDeserializer =
          (json, typeOfT, context) -> DateTime.parse(json.getAsString());
  protected final Gson gson = new GsonBuilder()
          .setPrettyPrinting()
          .registerTypeAdapter(org.joda.time.DateTime.class, dateTimeDeserializer)
          .create();
  protected final S3Client s3Client;
  protected final DefaultCredentialsProvider credentialsProvider = DefaultCredentialsProvider.create();
  protected final AcmPcaClient pcaClient;
  protected final IssueDeviceAttestationCertificate issueDeviceAttestationCertificate;

  public Handler() {
    s3Client = S3Client.create();
    pcaClient = AcmPcaClient.builder()
            .credentialsProvider(credentialsProvider)
            .build();
    issueDeviceAttestationCertificate = new IssueDeviceAttestationCertificate(pcaClient);
  }

  private static class S3Structure {
    public final String pcaArn;
    public final String pid;
    public final String name;
    public final String ext;

    public S3Structure(@NonNull final String key) {
      val keyParts = key.split("/");
      if (keyParts.length != 4 || !keyParts[3].contains(".")) {
        throw new RuntimeException("Unexpected key " + key + ", should be <pca_arn>/<PAI_ARN>/<pid>/<name>.csr");
      }

      pcaArn = keyParts[0] + '/' + keyParts[1];
      pid = keyParts[2];
      name = keyParts[3].substring(0, keyParts[3].lastIndexOf('.'));
      ext = keyParts[3].substring(keyParts[3].lastIndexOf('.') + 1);
    }

    @Override
    public String toString() {
      return pcaArn + '/' + pid + '/' + name + '.' + ext;
    }

    public String genOutputKey(@NonNull final String ext) {
      return pcaArn + '/' + pid + '/' + name + '.' + ext;
    }
  }

  @AllArgsConstructor
  private static class Request {
    public final S3Structure key;
    public final S3Entity s3Entity;
    public final String messageId;
  }

  @Override
  public SQSBatchResponse handleRequest(SQSEvent event, Context context)
  {
    final LambdaLogger logger = context.getLogger();
    val batchItemFailures = new ArrayList<SQSBatchResponse.BatchItemFailure>();

    // process event
    logger.log("Found " + event.getRecords().size() + " sqs event(s)");

    // Obtain all the S3 message and group them by their PAI.
    val requests = event.getRecords().stream().flatMap(sqsMessage -> {
      try {
        // The actual message is coming from S3, let's try to restore the original S3Event object.
        // Interestingly, accessor is called Records while property is called records, so we need to help Gson with it.
        final String body = sqsMessage.getBody().replace("Records", "records");
        val s3Event = gson.fromJson(body, S3Event.class);
        logger.log("Found " + s3Event.getRecords().size() + " s3 event(s)");  // Always 1 in our case.

        return s3Event.getRecords().stream().filter(s3Message -> {
          if (!s3Message.getEventSource().equals("aws:s3") || !s3Message.getEventName().equals("ObjectCreated:Put")) {
            logger.log("Skipping unexpected message " + s3Message);
            return false;
          }
          return true;
        }).map(s3Message -> Pair.of(s3Message.getS3(), sqsMessage.getMessageId()));
      } catch (JsonSyntaxException | JsonIOException | IllegalStateException ex) {
        logger.log("Skipping unexpected message " + sqsMessage.getBody() + " due to " + printException(ex));
        return Stream.of();
      }
    }).flatMap(s3Object -> {
      final S3Entity s3 = s3Object.left();
      final S3Structure s3Key;
      try {
        // Need to get URL mangling out of our way.
        final String keyUnwrapped = URLDecoder.decode(s3.getObject().getKey(), StandardCharsets.UTF_8);
        s3Key = new S3Structure(keyUnwrapped);
      } catch (Exception ex) {
        logger.log("Invalid input object key " + s3.getObject().getKey() + " (" + printException(ex) + "), skipping");
        return Stream.of();
      }

      return Stream.of(new Request(s3Key, s3, s3Object.right()));
    }).collect(Collectors.groupingBy(
            s3Key -> s3Key.key.pcaArn
    ));

    // For each group do the signing.
    for (val paiRequests : requests.entrySet()) {
      X500Name paiSubj;
      try {
        // Obtain the PAI first, because we need its VID and, if present, its PID.
        val paiRequest = GetCertificateAuthorityCertificateRequest.builder()
                .certificateAuthorityArn(paiRequests.getKey())
                .build();
        val pai = pcaClient.getCertificateAuthorityCertificate(paiRequest);

        // Parse the PAI CA certificate.
        val paiParser = new PEMParser(new StringReader(pai.certificate()));
        paiSubj = ((X509CertificateHolder) paiParser.readObject()).getSubject();
      } catch (IOException | AwsServiceException | SdkClientException ex) {
        logger.log("Couldn't obtain information about PAI " + paiRequests.getKey() + ", skipping " +
                   paiRequests.getValue().size() + " requests");
        for (val request : paiRequests.getValue()) {
          batchItemFailures.add(new SQSBatchResponse.BatchItemFailure(request.messageId));
        }
        continue;
      }
      val paiSubjDic = Arrays.stream(paiSubj.getRDNs()).collect(Collectors.toMap(
              rdn -> rdn.getFirst().getType().toString(),
              rdn -> rdn.getFirst().getValue().toString()));

      // Sign the requests using AWS PCA.
      for (val request : paiRequests.getValue()) {
        final String bucket = request.s3Entity.getBucket().getName();
        final String version = request.s3Entity.getObject().getVersionId();
        final S3Structure key = request.key;
        String certificate;
        try {
          certificate = processCsr(bucket, key, version, paiSubjDic);
        } catch (Exception ex) {
          val errMessage = "Skipping CSR " + bucket + '/' + paiRequests + " due to " + printException(ex);
          logger.log(errMessage);
          try {
            final String resultKey = key.genOutputKey("err");
            storeResult(bucket, resultKey, errMessage, s3Client);
          } catch (Exception s3Ex) {
            logger.log("Couldn't create .err file due to " + printException(s3Ex));
          }

          if (!(ex instanceof IllegalArgumentException)) {
            batchItemFailures.add(new SQSBatchResponse.BatchItemFailure(request.messageId));
          }
          continue;
        }

        // Store the result in S3.
        final String resultKey = key.genOutputKey("pem");
        try {
          val s3ObjVersion = storeResult(bucket, resultKey, certificate, s3Client);
          logger.log("Succeeded signing " + bucket + '/' + resultKey + ':' + s3ObjVersion);
        } catch (RuntimeException ex) {
          logger.log("Couldn't write object " + bucket + '/' + resultKey + " due to " + printException(ex));
          if (!(ex instanceof IllegalArgumentException)) {
            batchItemFailures.add(new SQSBatchResponse.BatchItemFailure(request.messageId));
          }
        }
      }
    }

    if (!batchItemFailures.isEmpty()) {
      logger.log("Failed " + batchItemFailures.size() + " request(s)");
    }

    return new SQSBatchResponse(batchItemFailures);
  }

  private String storeResult(@NonNull final String bucket,
                             @NonNull final String key,
                             @NonNull final String data,
                             @NonNull final S3Client s3Client) throws RuntimeException {
    val putObjectReq = PutObjectRequest.builder()
            .bucket(bucket)
            .key(key)
            .build();
    val putObjectRequestBody = RequestBody.fromString(data);
    try {
      val result = s3Client.putObject(putObjectReq, putObjectRequestBody);
      return result.versionId();
    } catch (NoSuchBucketException | NoSuchKeyException ex) {
      throw new IllegalArgumentException("Couldn't write object " + bucket + '/' + key, ex);
    } catch (Exception ex) {
      throw new RuntimeException("Couldn't write object " + bucket + '/' + key, ex);
    }
  }

  /**
   * @param s3Key      the key of {@code S3} object.
   * @param paiSubjDic map with PAI Subject's items.
   * @return resulting certificate.
   * @throws RuntimeException if anything goes wrong.
   * @apiNote {@code S3}'s key should start from PAI ARN and a slash following.
   */
  private @NonNull String processCsr(@NonNull final String bucket,
                                     @NonNull final S3Structure s3Key,
                                     @NonNull final String version,
                                     @NonNull final Map<String, String> paiSubjDic) throws RuntimeException {
    // Example input validation.
    if (!s3Key.ext.equals("csr")) {
      throw new IllegalArgumentException("Unexpected key " + s3Key + ", should have .csr extension");
    }

    final GetObjectRequest req = GetObjectRequest.builder()
            .bucket(bucket)
            .key(s3Key.toString())
            .versionId(version)
            .build();

    val result = s3Client.getObject(req);
    String csr;
    try {
      csr = new String(result.readAllBytes(), StandardCharsets.UTF_8);
    } catch (IOException ex) {
      throw new RuntimeException("Couldn't access S3 object " + s3Key, ex);
    }

    try {
      val validityPeriod = Long.valueOf(Optional.ofNullable(System.getenv("dacValidityInDays")).orElse(DEFAULT_VALIDITY)).longValue();
      return issueDeviceAttestationCertificate.run(s3Key.pcaArn, s3Key.pid, paiSubjDic, csr, validityPeriod);
    } catch (ResourceNotFoundException | InvalidArnException | InvalidArgsException | MalformedCsrException | IllegalArgumentException ex) {
      throw new IllegalArgumentException("Couldn't sign the request in " + bucket + '/' +
              s3Key + ':' + version, ex);
    } catch (Exception ex) {
      throw new RuntimeException("Couldn't sign the request in " + bucket + '/' + s3Key + ':' + version, ex);
    }
  }

  private static String printException(@NonNull final Throwable ex) {
    val sb = new StringBuilder();
    Throwable currEx = ex;
    do {
      sb.append(currEx);
      sb.append("\n");
      sb.append(Arrays.toString(currEx.getStackTrace()));
      sb.append("\n");
      currEx = currEx.getCause();
    } while (currEx != null);

    return sb.toString();
  }
}