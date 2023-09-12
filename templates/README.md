# CloudFormation Templates

This folder contains the AWS CloudFormation templates that were generated from the AWS CDK code. They can be deployed without having to install AWS CDK.

To deploy these stacks, run the following commands from within this directory:

## Create Deployment Bucket
```
aws s3api create-bucket --bucket <AWS_ACCOUNT_ID>-matter-cfn-deployment-assets --create-bucket-configuration LocationConstraint=<REGION>
```
Note: Make sure you have write access to the created bucket before proceeding.


## Deploy Lambda Assets
```
aws s3 cp assets/ s3://<AWS_ACCOUNT_ID>-matter-cfn-deployment-assets --recursive
```

## Deploy PAA Stack
```
aws cloudformation deploy --template-file PAAStack.yaml --stack-name PAAStack --parameter-overrides vendorId=<VENDOR_ID> {validityInDays=<PAA_VALIDITY>|validityEndDate=YYYYMMDDHHMMSS} paaCommonName=<PAA_COMMON_NAME> paaOrganization=<PAA_ORGANIZATION> [paaOU=<PAA_OU>] --capabilities CAPABILITY_NAMED_IAM --s3-bucket <AWS_ACCOUNT_ID>-matter-cfn-deployment-assets
```

Note that only one of the `validityInDays` and `validityEndDate` needs to be provided, but any `validityEndDate` overrides `validityInDays` option. `paaOU` can be omitted. See full list of options in [here](https://github.com/aws-samples/aws-private-ca-matter-infrastructure/blob/main/README.md).

## Deploy PAI Stack
Note: This template will only create a single PAI.
```
aws cloudformation deploy --template-file PAIStack.yaml --stack-name PAIStack --parameter-overrides vendorId=<VENDOR_ID> [productIds=<PRODUCT_ID_1>,<PRODUCT_ID_2>] {validityInDays=<PAI_VALIDITY>|validityEndDate=YYYYMMDDHHMMSS} paaArn=<PAA_ARN> paiCommonName=<PAI_COMMON_NAME> paiOrganization=<PAI_ORGANIZATION> [paiOU=<PAI_OU>] dacValidityInDay=<DAYS> --capabilities CAPABILITY_NAMED_IAM --s3-bucket <AWS_ACCOUNT_ID>-matter-cfn-deployment-assets
```

Note that only one of the `validityInDays` and `validityEndDate` needs to be provided, but any `validityEndDate` overrides `validityInDays` option. `paaOU` and `productIds` can be omitted. See full list of options in [here](https://github.com/aws-samples/aws-private-ca-matter-infrastructure/blob/main/README.md).