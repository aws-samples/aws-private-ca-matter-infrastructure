/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

package com.sample;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.LambdaLogger;
import com.amazonaws.services.lambda.runtime.events.S3Event;
import com.amazonaws.services.lambda.runtime.events.SQSEvent;
import com.amazonaws.services.lambda.runtime.events.models.s3.S3EventNotification;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonPrimitive;
import com.google.gson.JsonSerializer;
import lombok.val;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.core.exception.SdkClientException;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.acmpca.AcmPcaClient;
import software.amazon.awssdk.services.acmpca.model.*;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.NoSuchBucketException;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectResponse;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class HandlerTest {
    private final JsonSerializer<org.joda.time.DateTime> DateTimeSerializer = (src, typeOfSrc, context) -> new JsonPrimitive(src.toString());
    private final Gson gson = new GsonBuilder().registerTypeAdapter(org.joda.time.DateTime.class, DateTimeSerializer).create();

    private final Context context = mock(Context.class);// this.new TestContext();
    private final LambdaLogger logger = mock(LambdaLogger.class);
    private final S3Client s3Client = mock(S3Client.class);
    private final AcmPcaClient pcaClient = mock(AcmPcaClient.class);
    private final IssueDeviceAttestationCertificate issueDeviceAttestationCertificate = new IssueDeviceAttestationCertificate(pcaClient);
    private final Handler testHandler = new Handler(s3Client, pcaClient, issueDeviceAttestationCertificate);

    private static final String csr = "-----BEGIN CERTIFICATE REQUEST-----\n" +
            "MIIBKzCB0gIBADAiMSAwHgYDVQQDDBdEQUMgTXZpZDoxMzgxIE1waWQ6MTAwMTBZ\n" +
            "MBMGByqGSM49AgEGCCqGSM49AwEHA0IABH9ZA1RJ/HbJ+fHntuFrZoYGPdFJ5L0O\n" +
            "cdkoRhETbkFy1oHwit8vnzqs76y0wf88yIGqKJGNl93CgyWRD+zsp9qgTjBMBgkq\n" +
            "hkiG9w0BCQ4xPzA9MAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgeAMB0GA1Ud\n" +
            "DgQWBBQCd5NDR/m/twoDuMoZYGEZQLEBhzAKBggqhkjOPQQDAgNIADBFAiEArXHJ\n" +
            "2GCVTc1PSsmcTqEKW4IAGSFX+rv6+ZxBms9uDdACIEoxtyvC234LQk02yTg6zt1x\n" +
            "9WZDX5ic86lqSccEDBqm\n" +
            "-----END CERTIFICATE REQUEST-----\n";

    private static final String pai = "-----BEGIN CERTIFICATE-----\n" +
            "MIIBszCCAVmgAwIBAgIRAPNl1rKocY15od9ChqkyblgwCgYIKoZIzj0EAwIwJDEM\n" +
            "MAoGA1UEAwwDUEFBMRQwEgYKKwYBBAGConwCAQwEMTM4MTAeFw0yMjEyMDIyMTQ0\n" +
            "MjlaFw0zMjEyMDIyMjQ0MjlaMDoxDDAKBgNVBAMMA1BBSTEUMBIGCisGAQQBgqJ8\n" +
            "AgEMBDEzODExFDASBgorBgEEAYKifAICDAQxMDAxMFkwEwYHKoZIzj0CAQYIKoZI\n" +
            "zj0DAQcDQgAENRCS5U01LIU2r8QVC9b9G65KNoPgvwBVTYDXgc29bDwSjR7SiI6H\n" +
            "fXiUGefkn2I/8R6zrxg+z2Pd44brzAVuFaNWMFQwEgYDVR0TAQH/BAgwBgEB/wIB\n" +
            "ADAfBgNVHSMEGDAWgBQyUbS6RTotEidP8L+kuDa4mFjyozAdBgNVHQ4EFgQUs4Hx\n" +
            "cMCfLwqbBz3GJyVo9c1jCtcwCgYIKoZIzj0EAwIDSAAwRQIhALbwgV3LBeZR6GNC\n" +
            "ZiQN5D0fPZyqw9e8JWSr+BX5VGAeAiBlTSSMVlTpsa/i3fSLSfW1gws1ooSxRY72\n" +
            "RLOZ6Yc8YA==\n" +
            "-----END CERTIFICATE-----";

    private static final GetCertificateAuthorityCertificateResponse getCAResponse =
            GetCertificateAuthorityCertificateResponse.builder()
                    .certificate(pai)
                    .build();

    private final ResponseInputStream responseStream = mock(ResponseInputStream.class);
    private final GetCertificateResponse getCertResponse = mock(GetCertificateResponse.class);

    // private final static String key = "arn:pca/PAIArn/1001/request 1.csr";
    private final static String keyMangled = "arn%3Apca/PAIArn/1001/request+1.csr";
    private final static String keyForError = "arn:pca/PAIArn/1001/request 1.err";
    private final static String keyForPem = "arn:pca/PAIArn/1001/request 1.pem";
    private final static String key2 = "arn:pca/PAIArn/1001/request+2.crs";
    private final static String key3Mangled = "arn%3Apca/PAIArn/1002/request+3.csr";
    private final static S3EventNotification.S3EventNotificationRecord msg1S3Msg1 = new S3EventNotification.S3EventNotificationRecord(
            "us-west-2",
            "ObjectCreated:Put",
            "aws:s3",
            "2000-01-01T00:00:00.000Z",
            "2.1",
            new S3EventNotification.RequestParametersEntity("1.1.1.1"),
            new S3EventNotification.ResponseElementsEntity("aaa", "bbb"),
            new S3EventNotification.S3Entity(
                    "aaa",
                    new S3EventNotification.S3BucketEntity("bucket", new S3EventNotification.UserIdentityEntity("principalId"), "arn"),
                    new S3EventNotification.S3ObjectEntity(keyMangled, 1234L, "tag", "version", "sequencer"),
                    "schemaVersion"),
            new S3EventNotification.UserIdentityEntity("principalId"));

    private final static S3EventNotification.S3EventNotificationRecord msg1S3Msg2 = new S3EventNotification.S3EventNotificationRecord(
            "us-west-2",
            "ObjectCreated:Put",
            "aws:dynamodb", // wrong
            "2000-01-01T00:00:00.000Z",
            "2.1",
            new S3EventNotification.RequestParametersEntity("1.1.1.1"),
            new S3EventNotification.ResponseElementsEntity("aaa", "bbb"),
            new S3EventNotification.S3Entity(
                    "aaa",
                    new S3EventNotification.S3BucketEntity("bucket", new S3EventNotification.UserIdentityEntity("principalId"), "arn"),
                    new S3EventNotification.S3ObjectEntity(keyMangled, 1234L, "tag", "version", "sequencer"),
                    "schemaVersion"),
            new S3EventNotification.UserIdentityEntity("principalId"));

    private final static S3EventNotification.S3EventNotificationRecord msg1S3Msg3 = new S3EventNotification.S3EventNotificationRecord(
            "us-west-2",
            "ObjectCreated:Put",
            "aws:s3",
            "2000-01-01T00:00:00.000Z",
            "2.1",
            new S3EventNotification.RequestParametersEntity("1.1.1.1"),
            new S3EventNotification.ResponseElementsEntity("aaa", "bbb"),
            new S3EventNotification.S3Entity(
                    "aaa",
                    new S3EventNotification.S3BucketEntity("bucket", new S3EventNotification.UserIdentityEntity("principalId"), "arn"),
                    new S3EventNotification.S3ObjectEntity("key" /* wrong */, 1234L, "tag", "version", "sequencer"),
                    "schemaVersion"),
            new S3EventNotification.UserIdentityEntity("principalId"));

    private final static S3EventNotification.S3EventNotificationRecord msg1S3Msg4 = new S3EventNotification.S3EventNotificationRecord(
            "us-west-2",
            "ObjectCreated:Put",
            "aws:s3",
            "2000-01-01T00:00:00.000Z",
            "2.1",
            new S3EventNotification.RequestParametersEntity("1.1.1.1"),
            new S3EventNotification.ResponseElementsEntity("aaa", "bbb"),
            new S3EventNotification.S3Entity(
                    "aaa",
                    new S3EventNotification.S3BucketEntity("bucket", new S3EventNotification.UserIdentityEntity("principalId"), "arn"),
                    new S3EventNotification.S3ObjectEntity(key2 /* wrong */, 1234L, "tag", "version", "sequencer"),
                    "schemaVersion"),
            new S3EventNotification.UserIdentityEntity("principalId"));

    private final static S3EventNotification.S3EventNotificationRecord msg1S3Msg5 = new S3EventNotification.S3EventNotificationRecord(
            "us-west-2",
            "ObjectCreated:Put",
            "aws:s3",
            "2000-01-01T00:00:00.000Z",
            "2.1",
            new S3EventNotification.RequestParametersEntity("1.1.1.1"),
            new S3EventNotification.ResponseElementsEntity("aaa", "bbb"),
            new S3EventNotification.S3Entity(
                    "aaa",
                    new S3EventNotification.S3BucketEntity("bucket", new S3EventNotification.UserIdentityEntity("principalId"), "arn"),
                    new S3EventNotification.S3ObjectEntity(key3Mangled /* wrong */, 1234L, "tag", "version", "sequencer"),
                    "schemaVersion"),
            new S3EventNotification.UserIdentityEntity("principalId"));

    private final static S3Event msg1S3Event = new S3Event(List.of(msg1S3Msg1, msg1S3Msg2, msg1S3Msg3, msg1S3Msg4, msg1S3Msg5));

    private final SQSEvent.SQSMessage msg1 = new SQSEvent.SQSMessage();

    private final SQSEvent.SQSMessage msg2 = new SQSEvent.SQSMessage();

    private final SQSEvent event = new SQSEvent();

    public HandlerTest() {
        msg1.setEventSource("aws:sqs");
        msg1.setBody(gson.toJson(msg1S3Event).replace("records", "Records"));
        msg1.setMessageId("msg1");

        msg2.setEventSource("aws:sqs");
        msg2.setBody("blah");
        msg2.setMessageId("msg2");

        event.setRecords(List.of(msg1, msg2));
    }

    @BeforeEach
    void setUp() throws IOException {
        doReturn(logger).when(context).getLogger();
        doReturn(csr.getBytes(StandardCharsets.UTF_8)).when(responseStream).readAllBytes();
        doReturn(responseStream).when(s3Client).getObject(any(GetObjectRequest.class));
        doReturn(PutObjectResponse.builder().versionId("123").build()).when(s3Client)
                .putObject(any(PutObjectRequest.class), any(RequestBody.class));

        doReturn(getCAResponse).when(pcaClient).getCertificateAuthorityCertificate(any(GetCertificateAuthorityCertificateRequest.class));

        val issueCertResponse = mock(IssueCertificateResponse.class);
        doReturn(issueCertResponse).when(pcaClient).issueCertificate(any(IssueCertificateRequest.class));
        doReturn("certArn").when(issueCertResponse).certificateArn();

        doReturn(getCertResponse).when(pcaClient).getCertificate(any(GetCertificateRequest.class));
        doReturn("PEM").when(getCertResponse).certificate();
    }

    @Test
    void handleRequestHappyPath() {
        assertEquals(0, testHandler.handleRequest(event, context).getBatchItemFailures().size());
        verify(s3Client, times(1)).putObject(
                argThat((PutObjectRequest req) -> req.key().equals(keyForPem)),
                any(RequestBody.class));
    }

    @Test
    void handleRequestS3TransientFailure() {
        doThrow(SdkClientException.class).when(s3Client).putObject(any(PutObjectRequest.class), any(RequestBody.class));
        assertEquals(1, testHandler.handleRequest(event, context).getBatchItemFailures().size());
        verify(s3Client, times(1)).putObject(
                argThat((PutObjectRequest req) -> req.key().equals(keyForPem)),
                any(RequestBody.class));
    }

    @Test
    void handleRequestS3Failure() {
        doThrow(NoSuchBucketException.class).when(s3Client).putObject(any(PutObjectRequest.class), any(RequestBody.class));
        assertEquals(0, testHandler.handleRequest(event, context).getBatchItemFailures().size());
        verify(s3Client, times(1)).putObject(
                argThat((PutObjectRequest req) -> req.key().equals(keyForPem)),
                any(RequestBody.class));
    }

    @Test
    void handleRequestPcaTransientFailure() {
        doThrow(RequestFailedException.class).when(pcaClient).getCertificate(any(GetCertificateRequest.class));
        assertEquals(1, testHandler.handleRequest(event, context).getBatchItemFailures().size());
        verify(s3Client, times(1)).putObject(
                argThat((PutObjectRequest req) -> req.key().equals(keyForError)),
                any(RequestBody.class));
    }

    @Test
    void handleRequestPcaFailure() {
        doThrow(ResourceNotFoundException.class).when(pcaClient).issueCertificate(any(IssueCertificateRequest.class));
        assertEquals(0, testHandler.handleRequest(event, context).getBatchItemFailures().size());
        verify(s3Client, times(1)).putObject(
                argThat((PutObjectRequest req) -> req.key().equals(keyForError)),
                any(RequestBody.class));
    }
}