/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

package com.sample;

import lombok.NonNull;
import lombok.val;
import org.bouncycastle.asn1.x509.KeyUsage;
import org.bouncycastle.jce.X509KeyUsage;
import org.bouncycastle.openssl.PEMParser;
import org.bouncycastle.pkcs.PKCS10CertificationRequest;
import software.amazon.awssdk.core.SdkBytes;
import software.amazon.awssdk.services.acmpca.AcmPcaClient;
import software.amazon.awssdk.services.acmpca.model.*;

import java.io.IOException;
import java.io.StringReader;
import java.time.Duration;
import java.time.Period;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Adaptation of code in <a href="https://docs.aws.amazon.com/privateca/latest/userguide/JavaApiCBC-DeviceAttestationCertificate.html">PCA documentation</a>
 */
public class IssueDeviceAttestationCertificate {

   //protected final DefaultCredentialsProvider credentialsProvider = DefaultCredentialsProvider.create();
   protected final AcmPcaClient client;

   public IssueDeviceAttestationCertificate(@NonNull final AcmPcaClient client) {
      this.client = client;
   }

   private static String generateKeyUsageValue() throws IOException {
      KeyUsage keyUsage = new KeyUsage(X509KeyUsage.digitalSignature);
      byte[] kuBytes = keyUsage.getEncoded();
      return Base64.getEncoder().encodeToString(kuBytes);
   }

   public @NonNull String run(@NonNull final String paiArn,
                              @NonNull final String pid,
                              @NonNull Map<String, String> paiSubjDic,
                              @NonNull final String csr,
                              @NonNull final Period validityPeriod) throws IOException, InterruptedException {

      // Parse the PAI CA certificate.
      if (paiSubjDic.containsKey("1.3.6.1.4.1.37244.2.2") && !paiSubjDic.get("1.3.6.1.4.1.37244.2.2").equals(pid)) {
         throw new IllegalArgumentException("Cannot sign as PAI is product specific and supplied PID " + pid +
                 " is different from the one of the PAI - " + paiSubjDic.get("1.3.6.1.4.1.37244.2.2"));
      }

      // Parse CSR to obtain the Subject.
      val csrParser = new PEMParser(new StringReader(csr));
      val csrSubject = ((PKCS10CertificationRequest)csrParser.readObject()).getSubject();

      // Set the validity period for the certificate to be issued.
      val validity = Validity.builder()
              .type(ValidityPeriodType.MONTHS)
              .value(validityPeriod.toTotalMonths())
              .build();

      // Define custom attributes
      final List<CustomAttribute> customAttributes = Stream.concat(
                      Arrays.stream(csrSubject.getRDNs()).map(rdn -> CustomAttribute.builder()
                              .objectIdentifier(rdn.getFirst().getType().getId())
                              .value(rdn.getFirst().getValue().toString())
                              .build()),
                      Stream.of(
                              CustomAttribute.builder()
                                      .objectIdentifier("1.3.6.1.4.1.37244.2.1")     // matter-oid-vid
                                      .value(paiSubjDic.get("1.3.6.1.4.1.37244.2.1"))   // Must coincide with the one on PAI.
                                      .build(),
                              CustomAttribute.builder()
                                      .objectIdentifier("1.3.6.1.4.1.37244.2.2")     // matter-oid-pid
                                      .value(pid)
                                      .build()
                      ))
              .collect(Collectors.toList());

      // Define a cert subject.
      ASN1Subject subject = ASN1Subject.builder()
              .customAttributes(customAttributes)
              .build();

      // Generate Base64 encoded extension value for ExtendedKeyUsage
      String base64EncodedKUValue = generateKeyUsageValue();

      // Generate custom extension
      CustomExtension customKeyUsageExtension = CustomExtension.builder()
              .objectIdentifier("2.5.29.15") // KeyUsage Extension OID
              .value(base64EncodedKUValue)
              .critical(true)
              .build();

      Extensions extensions = Extensions.builder()
              .customExtensions(List.of(customKeyUsageExtension))
              .build();

      val apiPassthrough = ApiPassthrough.builder()
              .subject(subject)
              .extensions(extensions)
              .build();

      // Create a certificate request:
      final IssueCertificateRequest req =
              IssueCertificateRequest.builder()
                      // Set the CA ARN.
                      .certificateAuthorityArn(paiArn)
                      // Specify the certificate signing request (CSR) for the certificate to be signed and issued.
                      .csr(SdkBytes.fromUtf8String(csr))
                      // Specify the template for the issued certificate.
                      .templateArn("arn:aws:acm-pca:::template/BlankEndEntityCertificate_CriticalBasicConstraints_APIPassthrough/V1")
                      // Set the signing algorithm.
                      .signingAlgorithm(SigningAlgorithm.SHA256_WITHECDSA)
                      // Set the validity period for the certificate to be issued.
                      .validity(validity)
                      // Set the idempotency token.
                      .idempotencyToken("1234")
                      // Set the custom extensions.
                      .apiPassthrough(apiPassthrough)
                      .build();

      // Issue the certificate.
      IssueCertificateResponse result = client.issueCertificate(req);

      // Retrieve the certificate.
      final String certArn = result.certificateArn();

      final GetCertificateRequest certReq = GetCertificateRequest.builder()
              .certificateAuthorityArn(paiArn)
              .certificateArn(certArn)
              .build();

      do {
         try {
            return client.getCertificate(certReq).certificate();
         } catch (RequestInProgressException ignore) {
            // Not ready yet, let's wait longer
            Thread.sleep(Duration.ofSeconds(1L).toMillis());
         }
      } while (true);
   }
}
