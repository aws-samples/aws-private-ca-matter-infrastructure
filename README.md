# Welcome to your Matter PKI CDK project

This example demonstrates the use of AWS CDK to set up Public Key Infrastructure (PKI) infrastructure using AWS Private CA to help you meet the requirements of the Matter PKI Certificate Policy (CP) approved on December 19, 2022. Matter is a new standard for smart home security and device interoperability. Matter uses X.509 digital certificates to identify devices. Matter certificates can be issued only by CAs that comply with the Matter PKI Certificate Policy (CP). For more details about Matter, please see https://csa-iot.org/all-solutions/matter/.

The `cdk.json` file in this module instructs the CDK Toolkit how to deploy this sample into your AWS account. You can use this example to create Matter Product Attestation Authorities (PAA), Product Attestion Intermediates (PAI), AWS Identity and Access Management (IAM) roles and configure logging and log retention. Please note that in order for the DCL to view your Certificate Authority's CRLs, you must disable Block Public Access for your account, please see https://docs.aws.amazon.com/AmazonS3/latest/userguide/configuring-block-public-access-account.html.

## Multi-Party authorization with Change Manager

You can use the AWS Systems Manager (SSM) Automation Documents in the "ssm-automation" folder as an alternative way to create PAAs and PAIs. You can use these SSM Automation Documents in a SSM Change Manager template to create PAAs and PAIs under multi-party authorization. The README in the "ssm-automation" folder will walk you through how to use [SSM Change Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/change-manager.html) with these documents to implement multi-party authorization when creating Certificate Authorities (CAs) for Matter.

## Deploying without AWS CDK

You can use the AWS CloudFormation templates provided in the "templates" folder to deploy the stacks without having to install AWS CDK.

## Build

To build this app for AL2, you need to have JDK 11 or higher, [Gradle 7.6 or higher](https://gradle.org/install/), and Node.js installed on your system. (To install Node.js on an EC2 instance running AL2, see [Tutorial: Setting up Node.js on an Amazon EC2 instance](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/setting-up-node-on-ec2-instance.html) - note that AL2 requires the use of v16.)

From the example’s root folder, run the following commands:

```bash
npm install -g aws-cdk
npm install
./gradlew build
npm run build
```

This will install the necessary CDK, the example's dependencies, the Java package for Lambda, and then build your TypeScript files and your CloudFormation template.

## Bootstrap

An AWS environment must be bootstrapped once before CDK code can be deployed to it. To complete this bootstrapping run the following command before deploying for the first time:

```bash
cdk bootstrap
```

## Deploy

When deploying the application, you can configure it to support different use cases.
1. To generate a new PAA

   To generate a new PAA for use with Matter, use the following options:
    ```
    cdk deploy --context generatePaa=1 --parameters vendorId=<VENDOR_ID> --parameters {validityInDays=<PAA_VALIDITY>|validityEndDate=YYYYMMDDHHMMSS} --parameters vendorId=<MatterVendorId as 4-digit hex code> --parameters paaCommonName=<CN> --parameters paaOrganization=<O> [--parameters paaOU=<OU>]
    ```

   **Note:**
   While generating a new PAA, this example does not allow creating a new PAA without `vendorID` (non-VID scoped PAA). However, the Matter specification does allow non-VID scoped PAAs. If you change the code to create a non-VID scoped PAA, please ensure that you fully understand the audit and compliance requirements established by the Matter spec for non-VID scoped PAAs.
2. To use an existing PAA

   To alter an existing PAA for use with Matter, use the following options:
   ```
   cdk deploy --parameters paaArn=<PAA_ARN>
   ```
3. To generate PAIs in the same AWS Region as the PAA

   ```
   cdk deploy --context generatePaiCnt=<NUM_PAI> --parameters productIds=<PRODUCT_ID1,...> --parameters {validityInDays=<PAI_VALIDITY>|validityEndDate=YYYYMMDDHHMMSS} --parameters paaArn=<PAA_ARN> --parameters dacValidityInDays=<DAC_VALIDITY> --parameters paiCommonNames=<CN1,...> --parameters paiOrganizations=<O1,...>
   ```
4. To generate PAIs in a different AWS Region from the PAA

   The simplest way would be to specify another pre-configured AWS profile
   (see [AWS Cloud Development Kit documentation](https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli-environment)):

   ```
   cdk deploy --context generatePaiCnt=<NUM_PAI> --parameters productIds=<PRODUCT_ID1,...> --profile <YOUR_PROFILE_FOR_DIFFERENT_REGION> --parameters {validityInDays=<PAI_VALIDITY>|validityEndDate=YYYYMMDDHHMMSS} --parameters paaArn=<PAA_ARN> --parameters dacValidityInDays=<DAC_VALIDITY> --parameters paiCommonNames=<CN1,...> --parameters paiOrganizations=<O1,...>
   ```
5. To add more PAIs to the existing infrastructure

   Simply execute the same command again with increased `generatePaiCnt` parameter's value.

   You can view the difference between the new stack and what is already deployed by calling `cdk diff` with the necessary parameters. For example:
   ```
   cdk diff --context generatePaiCnt=<NUM_PAI> --parameters productIds=<PRODUCT_ID1,...> --parameters validityInDays=<PAI_VALIDITY> --parameters paaArn=<PAA_ARN>
   ```
6. To generate DAC certificates for each individual device to be embedded into its copy of a firmware

   ```shell
   $ echo "Choose the right format of the key (once)"
   $ openssl ecparam -name prime256v1 -out certificates/ecparam
    
   $ echo "Generate new key and new Certificate Signing Request"
   $ openssl req -config certificates/config.ssl -newkey param:certificates/ecparam -keyout key.pem -out cert.csr -sha256 -subj "/CN=DAC"
   
   $ echo "Sign the request using a PAI"
   $ aws s3 cp cert.csr s3://matterstackpai-dacinputs3tosqss3bucket<remainder of your bucket name>/arn:aws:acm-pca:<region>:<account>:certificate-authority/<PAI UUID>/<PID>/cert.csr
   
   $ echo "Wait until the pipeline finishes processing."
   $ echo "One way would be to poll s3 key for presence of .pem or .err (should a failure happen) files" 

   $ aws s3 cp s3://matterstackpai-dacinputs3tosqss3bucket<remainder of your bucket name>/arn:aws:acm-pca:<region>:<account>:certificate-authority/<PAI UUID>/<PID>/cert.pem .

   $ echo "Change the DAC validity as needed"
   $ aws lambda update-function-configuration --function-name <DAC_ISSUING_LAMBDA_NAME> --environment 'Variables={dacValidityInDays=<VALIDITY_IN_DAYS>}'
   ```

### Parameters
1. `--parameters vendorId=<VID>` - The vendor ID to be assigned to the CA. This must be a 4-digit hex value.
2. `--parameters productIds=<PID1>,<PID2>,...` - The productIds to be assigned to PAIs. Note that the number of PIDs provided should equal the `generatePaiCnt` parameter's value. These must be 4-digit hex values.
3. `--parameters validityInDays=<n>` - The PAA/PAI certificate's validity in days.
4. `--parameters validityEndDate=YYYYMMDDHHMMSS` - The PAA/PAI certificate's validity end date. This option always overrides the `validityInDays` counterpart.
5. `--parameters dacValidityInDays=<n>` - The validity in days of the DACs that are issued by the Lambda. This value must be less than the PAI's `validityInDays` value.
6. `--parameters paaArn=<PAA_ARN>` - The ARN of a PAA, used either to set up Matter PKI infrastructure around it, or to generate a new PAI.
7. `--parameters paaCommonName=<CN>` - CommonName (CN) is included in the Subject of the PAA.
8. `--parameters paaOrganization=<O>` - Organization (O) is included in the Subject of the PAA.
9. `--parameters paaOrganizationalUnit=<OU>` - If set, this OrganizationUnit (OU) is included in the Subject of the PAA.
10. `--parameters paiCommonNames=<CN1>,<CN2>,...` - CommonNames (CN) are included in the Subjects of the PAIs. Note that the number of CommonNames provided should equal the `generatePaiCnt` parameter's value.
11. `--parameters paiOrganizations=<O1>,<02>,...` - Organizations (O) are included in the Subjects of the PAIs. Note that the number of Organizations provided should equal the `generatePaiCnt` parameter's value.
12. `--parameters paiOrganizationalUnits=<OU1>,<0U2>,...` - If set, these OrganizationalUnits (OU) are included in the Subjects of the PAIs. Note that the number of OrganizationalUnits provided should equal the `generatePaiCnt` parameter's value.
13. `--parameters crlBucketName=<s3BucketName>` - If set, this sets the S3 Bucket name that your PAA/PAIs will use to store their CRLs.

### Context options
1. `--context generatePaiCnt=<NUM>` - If set, `<NUM>` new PAIs derived from PAA are created.
2. `--context generatePaa=1` - If set, a new PAA is generated, otherwise an existing PAA is expected (see `paaArn` parameter). This
   option is only used when `generatePaiCnt` isn't set.
3. `--context stackNamePrefix=<PREFIX>` - Optionally allows several PKI infrastructures to co-exist under different names.

### Hard-Coded Values
The following list contains some of the values that are hard-coded into the infrastructure. They can all be changed by modifying the CDK code or the CFN template directly.
1. `Audit Logging Bucket Object Retention` - Objects in the S3 audit logging bucket are retained for `5 years`.
2. `Audit Logging Bucket Glacier Transition` - Object in the S3 audit logging bucket are transitioned to Glacier after `2 months`.
3. `CloudWatch Log Group Retention` - Logs in the audit LogGroup are maintained in CloudWatch for `2 months`.

## Generate a CloudFormation Template

To see the CloudFormation template generated by the CDK, run `cdk synth` with some of the `--context` options above, then check the output file in the "cdk.out" directory.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `cdk bootstrap`   bootstrap AWS environment to prepare for deployment
* `cdk deploy`      deploy this stack to your default AWS account/region
* `cdk diff`        compare deployed stack with current state
* `cdk synth`       emits the synthesized CloudFormation template
