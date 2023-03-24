#!/bin/bash

set -euo pipefail

NUMBER_OF_REQUEST_APPROVERS=${1:-2}
AWS_ACCOUNT=$(aws sts get-caller-identity | jq -r '.Account')

echo "Creating CreatePAARole..."
aws iam create-role --role-name CreatePAARole --assume-role-policy-document file://policies/SSMTrustPolicy.json
PAA_POLICY_ARN=$(aws iam create-policy --policy-name CreatePAAPolicy --policy-document file://policies/CreatePAAPolicy.json | jq -r '.Policy.Arn')
aws iam attach-role-policy --role-name CreatePAARole --policy-arn $PAA_POLICY_ARN

echo "Creating CreatePAIRole..."
aws iam create-role --role-name CreatePAIRole --assume-role-policy-document file://policies/SSMTrustPolicy.json
PAI_POLICY_ARN=$(aws iam create-policy --policy-name CreatePAIPolicy --policy-document file://policies/CreatePAIPolicy.json | jq -r '.Policy.Arn')
aws iam attach-role-policy --role-name CreatePAIRole --policy-arn $PAI_POLICY_ARN

sed "s/<AccountID>/$AWS_ACCOUNT/g" policies/AccountTrustPolicy.json > policies/MyAccountTrustPolicy.json

for i in $(seq $NUMBER_OF_REQUEST_APPROVERS)
do
    REQUEST_APPROVER_ROLE_NAME="ChangeManagerRequestApproverRole$i"
    echo "Creating $REQUEST_APPROVER_ROLE_NAME..."
    aws iam create-role --role-name $REQUEST_APPROVER_ROLE_NAME --assume-role-policy-document file://policies/MyAccountTrustPolicy.json
    aws iam attach-role-policy --role-name $REQUEST_APPROVER_ROLE_NAME --policy-arn arn:aws:iam::aws:policy/AmazonSSMAutomationApproverAccess
    aws iam attach-role-policy --role-name $REQUEST_APPROVER_ROLE_NAME --policy-arn arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess
done

echo "Creating ChangeManagerTemplateApproverRole..."
aws iam create-role --role-name ChangeManagerTemplateApproverRole --assume-role-policy-document file://policies/MyAccountTrustPolicy.json
TEMPLATE_APPROVER_POLICY_ARN=$(aws iam create-policy --policy-name ChangeManagerTemplateApproverRole --policy-document file://policies/TemplateApproverPolicy.json | jq -r '.Policy.Arn')
aws iam attach-role-policy --role-name ChangeManagerTemplateApproverRole --policy-arn $TEMPLATE_APPROVER_POLICY_ARN
aws iam attach-role-policy --role-name ChangeManagerTemplateApproverRole --policy-arn arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess

echo "Creating SSM Service Linked Role..."
aws iam create-service-linked-role --aws-service-name ssm.amazonaws.com || echo -e "SSM Service Linked Role already created \n\n"

echo "Note: If you want to improve the security of your roles you can scope the following operations in the CreatePAIPolicy down to the specific PAA ARN(s) after creation:"
echo "acm-pca:GetCertificateAuthorityCertificate, acm-pca:GetCertificate, acm-pca:IssueCertificate"
