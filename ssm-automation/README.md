# Multi-Party Authorization with Change Manager

This repository contains example SSM Automation Documents that can be used by SSM [Change Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/change-manager.html) feature to create PAAs and PAIs using multi-party authorization.

## IAM Roles
This process will require the creation of IAM Roles to approve the Change Manager Templates and Requests, and execute the automation documents. Before beginning, please make sure that you have all of the roles listed below.

The creation of the roles can be automated by running `./createRoles.sh`. Make sure to set your AWS account ID and the number of approver roles you want to create in the script before running it. 

### CreatePAA and CreatePAI Roles
These roles will be used to execute the automation documents which create the PAAs and PAIs.

Trust Relationship:
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": [
                    "iam.amazonaws.com",
                    "ssm.amazonaws.com"
                ]
            },
            "Action": "sts:AssumeRole"
        }
    ]
}
```

Policy for CreatePAA:
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "acm-pca:ImportCertificateAuthorityCertificate",
                "acm-pca:IssueCertificate",
                "acm-pca:CreateCertificateAuthority",
                "acm-pca:GetCertificate",
                "acm-pca:GetCertificateAuthorityCsr",
                "acm-pca:DescribeCertificateAuthority"
            ],
            "Resource": "*"
        }
    ]
}
```

Policy for CreatePAI:
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "acm-pca:ImportCertificateAuthorityCertificate",
                "acm-pca:CreateCertificateAuthority",
                "acm-pca:GetCertificateAuthorityCsr",
                "acm-pca:DescribeCertificateAuthority"
            ],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "acm-pca:GetCertificateAuthorityCertificate",
                "acm-pca:GetCertificate",
                "acm-pca:IssueCertificate"
            ],
            "Resource": "*"
        }
    ]
}
```

### Request Approver Role
It is required that the roles which you want to approve the Change Manager Requests have the following permissions:

Trust Relationship:
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "AWS": "arn:aws:iam::<AccountID>:root"
            },
            "Action": "sts:AssumeRole",
            "Condition": {}
        }
    ]
}
```

Managed Policies:
1. [AmazonSSMAutomationApproverAccess](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonSSMAutomationApproverAccess.html)
2. [AmazonSSMReadOnlyAccess](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonSSMReadOnlyAccess.html)

### Template Approver Role
It is required that the role you want to use to approve the Change Manager Templates has the following permissions:

Trust Relationship:
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "AWS": "arn:aws:iam::<AccountID>:root"
            },
            "Action": "sts:AssumeRole",
            "Condition": {}
        }
    ]
}
```

Managed Policy:
1. [AmazonSSMReadOnlyAccess](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonSSMReadOnlyAccess.html)

Approval Policy:
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "VisualEditor0",
            "Effect": "Allow",
            "Action": "ssm:UpdateDocumentMetadata",
            "Resource": "*"
        }
    ]
}
```

### SSM Service Linked Role
If you get the following error message while executing your Change Manager request

`Failed to schedule runbook after step approved. Invalid permissions: Couldn't assume/create SSM SLR, check permissions for the calling identity.`

Run the following command to create the missing SLR:

`aws iam create-service-linked-role --aws-service-name ssm.amazonaws.com`

## Creating a PAI/PAA with Change Manager
To create a PAA or PAI with multiple approvers follow these steps:
1. Go to the [Documents](https://console.aws.amazon.com/systems-manager/documents) section in AWS Systems Manager.
2. Begin creating a new Automation Document.
3. In the Editor tab paste the contents of the document exactly as it is in this repository.
4. Go to the [Change Manager](https://console.aws.amazon.com/systems-manager/change-manager) page of the Systems Manager console.
5. Begin creating a new Template.
6. For the Runbook option, choose the Automation Document you created.
7. Choose the desired approvers and fill in the rest of the fields.
8. Submit the Template for review. **Note:** Make sure that you have the [Template Approver Role](#template-approver-role) registered in the "Settings" tab of Change Manager under "Template Reviewer".
9. Approve the Template using the Template Approver Role.
10. Start creating a new Request in Change Manager.
11. Choose the Template you just created.
12. Fill in all of the necessary fields.
13. Provide the parameters with which the Automation Document will run while creating your PAA/PAI.
14. Select the [CreatePAA or CreatePAI role](#createpaa-and-createpai-roles) for the "Automation assume role" section.
15. Make sure all required approvers (with the permissions described in [Request Approver Role](#request-approver-role)) approve the Request.
