# Multi-Party Authorization with Change Manager

This repository contains example SSM Automation Documents that can be used by SSM [Change Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/change-manager.html) feature to create PAAs and PAIs using multi-party authorization.

**Note:** This process will require IAM Roles with permissions to access AWS Private CA. Before beginning, please make sure that you have an IAM role with the following trust relationship and permissions:

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

For CreatePAA:
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

For CreatePAI:
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
            "Resource": "<PAA_ARN>"
        }
    ]
}
```

To create a PAA or PAI with multiple approvers follow these steps:
1. Go to the [Documents](https://console.aws.amazon.com/systems-manager/documents) section in AWS Systems Manager.
2. Begin creating a new Automation Document.
3. In the Editor tab paste the contents of the document exactly as it is in this repository.
4. Go to the [Change Manager](https://console.aws.amazon.com/systems-manager/change-manager) page of the Systems Manager console.
5. Begin creating a new Template.
6. For the Runbook option, choose the Automation Document you created.
7. Choose the desired approvers and fill in the rest of the fields.
8. Submit the Template for review. **Note:** Make sure that you have a "Template Reviewer" registered in the "Settings" tab of Change Manager.
9. Approve the Template.
10. Start creating a new Request in Change Manager.
11. Choose the Template you just created.
12. Fill in all of the necessary fields.
13. Provide the parameters with which the Automation Document will run while creating your PAA/PAI.
14. Make sure all required approvers approve the Request.
