/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import {
    Arn,
    ArnFormat,
    CfnCondition,
    CfnDeletionPolicy,
    CfnOutput,
    CfnParameter,
    CfnResource,
    CustomResource,
    CustomResourceProvider,
    CustomResourceProviderRuntime,
    Duration,
    Fn, ICfnConditionExpression, ICfnRuleConditionExpression,
    Stack,
    Tags, Token
} from 'aws-cdk-lib';
import {Construct, IConstruct} from 'constructs';
import {
    AccountPrincipal,
    ArnPrincipal,
    Effect,
    IRole,
    ManagedPolicy,
    Policy,
    PolicyStatement,
    Role,
    ServicePrincipal
} from 'aws-cdk-lib/aws-iam';
import {S3EventSelector, Trail} from "aws-cdk-lib/aws-cloudtrail"
import {Bucket, BucketEncryption, CfnBucket, IBucket, StorageClass} from 'aws-cdk-lib/aws-s3';
import {Schedule} from "aws-cdk-lib/aws-events";
import {BackupPlan, BackupPlanRule, BackupResource, BackupVault} from "aws-cdk-lib/aws-backup";
import {LogGroup, MetricFilter, RetentionDays} from "aws-cdk-lib/aws-logs";
import * as pca from "aws-cdk-lib/aws-acmpca";
import {CfnCertificateAuthorityActivation} from "aws-cdk-lib/aws-acmpca";
import {S3ToSqs} from "@aws-solutions-constructs/aws-s3-sqs";
import {SqsToLambda} from "@aws-solutions-constructs/aws-sqs-lambda";
import * as lambda from "aws-cdk-lib/aws-lambda";
import {AwsCustomResource} from "aws-cdk-lib/custom-resources";
import {StringParameter} from "aws-cdk-lib/aws-ssm";
import {Key} from 'aws-cdk-lib/aws-kms';

export class MatterStack extends Stack {
    public readonly matterIssueDACRole: Role | IRole;
    public readonly matterIssuePAIRole: Role | IRole;
    public readonly matterAuditorRole: Role | IRole;
    public readonly matterManagePAARole: Role | IRole;
    public readonly matterAuditLoggingBackupRole: Role | IRole;

    public static readonly matterPKITag = "matterPKITag";       // The tag that should be attached to all PAIs created in PCA.
    public static readonly matterCATypeTag = "matterCAType";    // The tag that should be attached to all CAs created in PCA and have value "paa" or "pai" only.
    public static readonly matterCrlBucketName = "matter-crl-bucket";

    public static readonly MATTER_ISSUE_PAI_ROLE_NAME =  "MatterIssuePAIRole"
    public static readonly MATTER_MANAGE_PAA_ROLE_NAME = "MatterManagePAARole"
    public static readonly MATTER_AUDITOR_ROLE_NAME = "MatterAuditorRole"
    public static readonly MATTER_AUDIT_LOGGING_BACKUP_ROLE_NAME = 'S3BackupRole'
    public static readonly MATTER_ISSUE_DAC_ROLE = "MatterIssueDACRole"
    private static readonly matterPKIRolesPath = "/MatterPKI/";

    constructor(scope: Construct, id: string, prefix: string, genPaiCnt: string | undefined) {
        super(scope, id);

        const root = genPaiCnt === undefined;

        // Note that CFN parameters are ony defined when you deploy resulting CFN template and provide values for them.

        let paaRegion: string = this.region;
        if (root) {
            // Create Or Fetch PAA
            let paaArn: string;
            if (this.node.tryGetContext('generatePaa') === undefined) {
                paaArn = new CfnParameter(this, "paaArn", {
                    type: "String",
                    description: "The ARN of the Private Certificate Authority CA that is used as the Matter Product Attestation " +
                                 "Authority (PAA)."
                }).valueAsString;
            } else {
                const validityInDays = new CfnParameter(this, "validityInDays", {
                    type: "Number",
                    description: "Validity in days for new PAA",
                    default: 3650
                }).valueAsNumber;
                const validityEndDate = new CfnParameter(this, "validityEndDate", {
                    type: "String",
                    description: "Validity End Date, is optional and overrides validityInDays. It's in YYYYMMDDHHMMSS format.",
                    default: ''
                }).valueAsString;
                const vendorIdInput = new CfnParameter(this, "vendorId", {
                    type: "String",
                    description: "The vendorId associated with this PAA. This must be a 4-digit hex value."
                }).valueAsString;

                const vendorId = this.validateVid(vendorIdInput);

                let commonName = new CfnParameter(this, 'paaCommonName', {
                    type: "String",
                    description: "The Common Name for this PAA."
                }).valueAsString;
                let paaOrganization = new CfnParameter(this, 'paaOrganization', {
                    type: "String",
                    description: "The Organization associated with this PAA."
                }).valueAsString;
                let paaOrganizationUnit = new CfnParameter(this, 'paaOU', {
                    type: "String",
                    description: "The Organizational Unit associated with this PAA.",
                    default: ''
                }).valueAsString;

                const crlBucket = this.createMatterCrlBucket(MatterStack.matterCrlBucketName);
                const validity = this.createPcaValidityInstance(validityInDays, validityEndDate);
                const paaActivation = this.createPAA(commonName, crlBucket.bucketName, paaOrganization, paaOrganizationUnit, validity, vendorId);
                paaArn = paaActivation.certificateAuthorityArn
            }

            // Global resources.
            this.matterManagePAARole = this.createMatterManagePAARole(prefix + MatterStack.MATTER_MANAGE_PAA_ROLE_NAME, paaArn);
            this.matterIssuePAIRole = this.createMatterIssuePAIRole(prefix + MatterStack.MATTER_ISSUE_PAI_ROLE_NAME, paaArn);
            this.matterAuditorRole = this.createMatterAuditorRole(prefix + MatterStack.MATTER_AUDITOR_ROLE_NAME, paaArn);
            this.matterAuditLoggingBackupRole = this.createMatterAuditLoggingBackupRole(prefix + MatterStack.MATTER_AUDIT_LOGGING_BACKUP_ROLE_NAME);
            this.matterIssueDACRole = this.createMatterIssueDACRole(prefix + MatterStack.MATTER_ISSUE_DAC_ROLE);
        }
        else {
            // Create PAI
            let prodIdsInput = new CfnParameter(this, "productIds", {
                type: "String",
                description: "A comma-separated list of product IDs associated with PAIs. These must be 4-digit hex values.",
                default: ''
            })?.valueAsString;
            const validityInDays = new CfnParameter(this, "validityInDays", {
                type: "Number",
                description: "Validity in days for new PAI(s)",
                default: 3600
            }).valueAsNumber;
            const validityEndDate = new CfnParameter(this, "validityEndDate", {
                type: "String",
                description: "Validity End Date, is optional and overrides validityInDays. It's in YYYYMMDDHHMMSS format.",
                default: ''
            }).valueAsString;
            const dacValidityInDays = new CfnParameter(this, "dacValidityInDays", {
                type: "Number",
                description: "Validity in days for DACs issued by the Lambda."
            }).valueAsNumber;
            const paaArn = new CfnParameter(this, "paaArn", {
                type: "String",
                description: "ARN of the PAA"
            }).valueAsString;
            paaRegion = Arn.split(paaArn, ArnFormat.SLASH_RESOURCE_NAME).region!;

            const prodIdsSet = new CfnCondition(this, 'PidsWereProvided', {
                expression: Fn.conditionNot(Fn.conditionEquals(prodIdsInput, ''))
            });
            const prodIds = this.validatePids(prodIdsInput, prodIdsSet);

            let commonNames = new CfnParameter(this, 'paiCommonNames', {
                type: "String",
                description: "The Common Name for this PAI"
            }).valueAsString;
            let crlBucketName = new CfnParameter(this, 'crlBucketName', {
                type: "String",
                description: "The Bucket Name for the CRL Bucket"
            }).valueAsString;
            let organizations = new CfnParameter(this, 'paiOrganizations', {
                type: "String",
                description: "The Organization associated with this PAI"
            }).valueAsString;
            let organizationalUnits = new CfnParameter(this, 'paiOrganizationalUnits', {
                type: "String",
                description: "The Organizational Unit associated with this PAI",
                default: ''
            }).valueAsString;

            const ouSet = new CfnCondition(this, "paiOUWasProvided", {
                expression: Fn.conditionNot(Fn.conditionEquals(organizationalUnits, ''))
            });

            const vendorId = this.getPaaVendorId(paaArn, paaRegion);
            const paaPem = this.getCertificatePem(id, paaArn, paaRegion);
            const validity = this.createPcaValidityStrings(validityInDays, validityEndDate);
            for (let index = 0; index < parseInt(genPaiCnt); index++) {
                const commonName = Fn.select(index, Fn.split(',', commonNames));
                const organization = Fn.select(index, Fn.split(',', organizations));
                const organizationalUnit = Fn.conditionIf(ouSet.logicalId, Fn.select(index, Fn.split(',', organizationalUnits)), '');
                this.createPAI(commonName, crlBucketName, organization, organizationalUnit, ouSet, validity, vendorId, index, prodIds, prodIdsSet, paaArn, paaRegion, paaPem);
            }

            // Global resources.
            this.matterManagePAARole =
                Role.fromRoleName(this, "MatterManagePAARoleInPAIStack", MatterStack.MATTER_MANAGE_PAA_ROLE_NAME)
            this.matterIssuePAIRole =
                Role.fromRoleName(this, "MatterIssuePAIRoleInPAIStack", MatterStack.MATTER_ISSUE_PAI_ROLE_NAME)
            this.matterAuditorRole =
                Role.fromRoleName(this, "MatterAuditorRoleInPAIStack", MatterStack.MATTER_AUDITOR_ROLE_NAME)
            this.matterAuditLoggingBackupRole = Role.fromRoleName(this, "MatterAuditLoggingBackupRoleInPAIStack",
                MatterStack.MATTER_AUDIT_LOGGING_BACKUP_ROLE_NAME)
            this.matterIssueDACRole =
                Role.fromRoleName(this, "MatterIssueDACRoleInPAIStack", MatterStack.MATTER_ISSUE_DAC_ROLE)
            this.createDacIssuingLambda(dacValidityInDays);
        }

        // Regional resources shared between PAA and PAI stacks.
        const regionalSharedWithPAAStackResources: IConstruct[] = [];
        const [matterAuditLoggingBackupPlan, matterAuditLoggingBackupPlanTree] = this.createMatterAuditLoggingBackupPlan(prefix);
        regionalSharedWithPAAStackResources.push(...matterAuditLoggingBackupPlanTree);
        const [matterAuditLoggingBucket, matterAuditLoggingBucketTree] = this.createMatterAuditLoggingBucket(prefix, matterAuditLoggingBackupPlan);
        regionalSharedWithPAAStackResources.push(...matterAuditLoggingBucketTree);
        const [auditLogGroup, auditLogGroupTree] = this.createAuditLogGroup(prefix, root, matterAuditLoggingBucket, matterAuditLoggingBackupPlan);
        regionalSharedWithPAAStackResources.push(...auditLogGroupTree);

        const [, auditCloudTrailTree] = this.createAuditCloudTrail(prefix, root, auditLogGroup, matterAuditLoggingBucket);
        regionalSharedWithPAAStackResources.push(...auditCloudTrailTree);

        if (!root) {
            // Do not re-create regional shared with PAA Stack resources when adding PAIs into the same region.
            const createCondition = new CfnCondition(
                this,
                'isMultiRegion',
                {
                    // a condition needs an expression
                    expression: Fn.conditionNot(Fn.conditionEquals(this.region, paaRegion))
                }
            )
            regionalSharedWithPAAStackResources.map((v) => v.node.defaultChild as CfnResource).forEach((inst) => {
                inst.cfnOptions.condition = createCondition;
            });
        }
    }

    private getPaaVendorId(paaArn: string, paaRegion: string) {
        const provider = CustomResourceProvider.getOrCreateProvider(this, 'Custom::LambdaFunctionUtils', {
            codeDirectory: `${__dirname}`,
            runtime: CustomResourceProviderRuntime.NODEJS_18_X,
            description: "Utility Lambda function"
        });
        provider.addToRolePolicy({
            Effect: 'Allow',
            Action: 'acm-pca:DescribeCertificateAuthority',
            Resource: paaArn,
        });
        return new CustomResource(this, 'ObtainPaaVid', {
            serviceToken: provider.serviceToken,
            resourceType: 'Custom::GetPaaVendorIdType',
            properties: {
                "command": "getPaaVendorId",
                "paaArn": paaArn,
                "paaRegion": paaRegion
            }
        }).getAtt('Result').toString();
    }

    private validatePids(pids: string, pidsSet: CfnCondition): string[] {
        const provider = CustomResourceProvider.getOrCreateProvider(this, 'Custom::LambdaFunctionUtils', {
            codeDirectory: `${__dirname}`,
            runtime: CustomResourceProviderRuntime.NODEJS_18_X,
            description: "Utility Lambda function"
        });
        const outcome = new CustomResource(this, 'ValidatePid', {
            serviceToken: provider.serviceToken,
            resourceType: 'Custom::ValidatePidType',
            properties: {
                "command": "validateVidPid",
                "vid": undefined,
                "pids": Fn.conditionIf(pidsSet.logicalId, Fn.split(',', pids), ['AAAA'])
            }
        });
        return outcome.getAtt('pids')!.toStringList();
    }

    private validateVid(vid: string): string {
        const provider = CustomResourceProvider.getOrCreateProvider(this, 'Custom::LambdaFunctionUtils', {
            codeDirectory: `${__dirname}`,
            runtime: CustomResourceProviderRuntime.NODEJS_18_X,
            description: "Utility Lambda function"
        });
        const outcome = new CustomResource(this, 'ValidateVid', {
            serviceToken: provider.serviceToken,
            resourceType: 'Custom::ValidateVidType',
            properties: {
                "command": "validateVidPid",
                "vid": vid,
                "pids": undefined
            }
        });
        return outcome.getAtt('vid')!.toString();
    }

    // Creates the IAM role for issuing and revoking Device Attestation Certificates (DACs)
    private createMatterIssueDACRole(roleName: string): Role {
        const matterIssueDACRole = new Role(this, roleName, {
            assumedBy: new AccountPrincipal(this.account),
            roleName: roleName,
            path: MatterStack.matterPKIRolesPath
        });

        Tags.of(matterIssueDACRole).add(MatterStack.matterPKITag, "");

        matterIssueDACRole.attachInlinePolicy(
            new Policy(this, `IssueDACCert`, {
                statements: this.getPolicyStatementsForDACIssuance(),
            }),
        );

        return matterIssueDACRole;
    }

    private getPolicyStatementsForDACIssuance(): PolicyStatement[] {
        return [
            new PolicyStatement({ // Allow issuance of only DACs from PAIs
                actions: ["acm-pca:IssueCertificate"],
                effect: Effect.ALLOW,
                resources: ["*"],
                conditions: {
                    StringLike: {
                        "acm-pca:TemplateArn": "arn:aws:acm-pca:::template/BlankEndEntityCertificate_CriticalBasicConstraints_APIPassthrough/V*"
                    },
                    StringEquals: {
                        "aws:ResourceTag/matterCAType": "pai"
                    }
                }
            }),
            new PolicyStatement({ // Deny issuance of certs other than DACs
                actions: ["acm-pca:IssueCertificate"],
                effect: Effect.DENY,
                resources: ["*"],
                conditions: {
                    StringNotLike: {
                        "acm-pca:TemplateArn": "arn:aws:acm-pca:::template/BlankEndEntityCertificate_CriticalBasicConstraints_APIPassthrough/V*"
                    },
                    StringEquals: {
                        "aws:ResourceTag/matterCAType": "pai"
                    }
                }
            }),
            new PolicyStatement({
                actions: ["acm-pca:RevokeCertificate",
                    "acm-pca:GetCertificate",
                    "acm-pca:GetCertificateAuthorityCertificate",
                    "acm-pca:DescribeCertificateAuthority"],
                effect: Effect.ALLOW,
                resources: ["*"],
                conditions: {
                    StringEquals: {
                        "aws:ResourceTag/matterCAType": "pai"
                    }
                }
            }),
            new PolicyStatement({
                actions: ["acm-pca:ListCertificateAuthorities"],
                effect: Effect.ALLOW,
                resources: ["*"],
            }),
        ];
    }

// Creates the IAM role for creating and managing Product Attestation Intermediates (PAIs)
    private createMatterIssuePAIRole(roleName: string, paaArn: string): Role {
        const matterIssuePAIRole = new Role(this, roleName, {
            assumedBy: new AccountPrincipal(this.account),
            roleName: roleName,
            path: MatterStack.matterPKIRolesPath
        });

        Tags.of(matterIssuePAIRole).add(MatterStack.matterPKITag, "");

        matterIssuePAIRole.attachInlinePolicy(
            new Policy(this, `IssuePAICert`, {
                statements: [
                    new PolicyStatement({ // Allow issuance of only PAI certs from PAAs
                        actions: ["acm-pca:IssueCertificate"],
                        effect: Effect.ALLOW,
                        resources: [paaArn],
                        conditions: {
                            StringLike : {
                                "acm-pca:TemplateArn": "arn:aws:acm-pca:::template/BlankSubordinateCACertificate_PathLen0_APIPassthrough/V*"
                            }
                        }
                    }),
                    new PolicyStatement({ // Deny issuance of certs other than PAI certs
                        actions: ["acm-pca:IssueCertificate"],
                        effect: Effect.DENY,
                        resources: [paaArn],
                        conditions: {
                            StringNotLike : {
                                "acm-pca:TemplateArn": "arn:aws:acm-pca:::template/BlankSubordinateCACertificate_PathLen0_APIPassthrough/V*"
                            }
                        }
                    }),
                    new PolicyStatement({
                        actions: ["acm-pca:GetCertificateAuthorityCertificate",
                            "acm-pca:ImportCertificateAuthorityCertificate",
                            "acm-pca:DeleteCertificateAuthority",
                            "acm-pca:UpdateCertificateAuthority",
                            "acm-pca:DescribeCertificateAuthority",
                            "acm-pca:GetCertificateAuthorityCsr"],
                        effect: Effect.ALLOW,
                        resources: ["*"],
                        conditions: {
                            StringEquals : {
                                "aws:ResourceTag/matterCAType": "pai"
                            }
                        }
                    }),
                    new PolicyStatement({
                        actions: ["acm-pca:RevokeCertificate",
                            "acm-pca:GetCertificate",
                            "acm-pca:GetCertificateAuthorityCertificate",
                            "acm-pca:DescribeCertificateAuthority"],
                        effect: Effect.ALLOW,
                        resources: [paaArn],
                    }),
                    new PolicyStatement({
                        actions: ["acm-pca:ListCertificateAuthorities",
                            "acm-pca:CreateCertificateAuthority",
                            "acm-pca:TagCertificateAuthority"],
                        effect: Effect.ALLOW,
                        resources: ["*"],
                    }),
                ],
            }),
        );

        return matterIssuePAIRole;
    }

    // Creates the read-only IAM role for auditing the Matter PKI
    private createMatterAuditorRole(roleName: string, paaArn: string): Role {
        const matterAuditorRole = new Role(this, roleName, {
            assumedBy: new AccountPrincipal(this.account),
            roleName: roleName,
            path: MatterStack.matterPKIRolesPath
        });

        Tags.of(matterAuditorRole).add(MatterStack.matterPKITag, "");

        matterAuditorRole.attachInlinePolicy(
            new Policy(this, `MatterAuditor`, {
                statements: [
                    new PolicyStatement({
                        actions: ["acm-pca:CreateCertificateAuthorityAuditReport",
                            "acm-pca:DescribeCertificateAuthority",
                            "acm-pca:DescribeCertificateAuthorityAuditReport",
                            "acm-pca:GetCertificateAuthorityCsr",
                            "acm-pca:GetCertificateAuthorityCertificate",
                            "acm-pca:GetCertificate",
                            "acm-pca:GetPolicy",
                            "acm-pca:ListPermissions",
                            "acm-pca:ListTags"],
                        effect: Effect.ALLOW,
                        resources: [paaArn],
                    }),
                    new PolicyStatement({
                        actions: ["acm-pca:CreateCertificateAuthorityAuditReport",
                            "acm-pca:DescribeCertificateAuthority",
                            "acm-pca:DescribeCertificateAuthorityAuditReport",
                            "acm-pca:GetCertificateAuthorityCsr",
                            "acm-pca:GetCertificateAuthorityCertificate",
                            "acm-pca:GetCertificate",
                            "acm-pca:GetPolicy",
                            "acm-pca:ListPermissions",
                            "acm-pca:ListTags"],
                        effect: Effect.ALLOW,
                        resources: ["*"],
                        conditions: {
                            StringEquals : {
                                "aws:ResourceTag/matterCAType": "pai"
                            }
                        }
                    })
                ],
            }),
        );

        /*
            Note: This role gains access to the S3 bucket where the logs are stored via S3 resource policies when the bucket is created.
                  Access to the CloudWatch LogGroup is also granted below when the LogGroup is created.
        */

        return matterAuditorRole;
    }

    // Creates the IAM role for managing Product Attestation Authorities (PAAs)
    private createMatterManagePAARole(roleName: string, paaArn: string): Role {
        const matterManagePAARole = new Role(this, roleName, {
            assumedBy: new AccountPrincipal(this.account),
            roleName: roleName,
            path: MatterStack.matterPKIRolesPath
        });

        Tags.of(matterManagePAARole).add(MatterStack.matterPKITag, "");

        matterManagePAARole.attachInlinePolicy(
            new Policy(this, `MatterPAA`, {
                statements: [
                    new PolicyStatement({
                        actions: ["acm-pca:UpdateCertificateAuthority",
                            "acm-pca:DescribeCertificateAuthority",
                            "acm-pca:GetCertificate",
                            "acm-pca:GetCertificateAuthorityCertificate"],
                        effect: Effect.ALLOW,
                        resources: [paaArn],
                    }),
                    new PolicyStatement({
                        actions: ["acm-pca:ListCertificateAuthorities"],
                        effect: Effect.ALLOW,
                        resources: ["*"],
                    }),
                ],
            }),
        );

        return matterManagePAARole;
    }

    // Create the backup plan using AWS Backup for the Matter PKI audit logging S3 bucket
    private createMatterAuditLoggingBackupPlan(prefix: string): [BackupPlan, IConstruct[]] {
        const dependencies: IConstruct[] = [];

        const plan = new BackupPlan(this, prefix + "MatterAuditLoggingBackupPlan", {
            backupPlanName: prefix + "MatterAuditLoggingBackupPlan"
        });
        dependencies.push(plan);
        const vault = new BackupVault(this, prefix + "MatterAuditLoggingBackupVault", {
            backupVaultName: prefix + "MatterAuditLoggingBackupVault"
        });
        dependencies.push(vault);

        plan.addRule(new BackupPlanRule({
            backupVault: vault,
            ruleName: "RuleForMonthlyBackups",
            scheduleExpression: Schedule.cron({minute: '0', hour: '0', day: '1', month: '*', year: '*'}), // monthly backup on first of every month
            deleteAfter: Duration.days(32), // 1 extra day, so that at-least one backup will stay in all conditions
        }));

        return [plan, dependencies];
    }

    // Creates the IAM role that will be used by AWSBackup to back-up data in audit logging S3 bucket
    private createMatterAuditLoggingBackupRole(roleName: string): Role {
        return new Role(this, roleName, {
            roleName: roleName,
            assumedBy: new ServicePrincipal('backup.amazonaws.com'),
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForBackup'),
                ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForRestores'),
                ManagedPolicy.fromAwsManagedPolicyName('AWSBackupServiceRolePolicyForS3Backup'),
                ManagedPolicy.fromAwsManagedPolicyName('AWSBackupServiceRolePolicyForS3Restore'),
            ],
            path: MatterStack.matterPKIRolesPath
        });
    }

    // Creates the S3 bucket and Glacier vault that will contain the logs and audit data for Matter PKI.
    private createMatterAuditLoggingBucket(prefix: string, matterAuditLoggingBackupPlan: BackupPlan): [Bucket, IConstruct[]] {
        const dependencies: IConstruct[] = [];

        const bucketKMSKey = new Key(this, 'MatterPKIAuditLogsKMSKey', {
            enableKeyRotation: true
        })
        bucketKMSKey.grantEncrypt(new ServicePrincipal('cloudtrail.amazonaws.com'));

        dependencies.push(bucketKMSKey);

        const matterAuditLoggingBucket = new Bucket(this, prefix + `matter-pki-audit-logs`, {
            versioned: true,
            blockPublicAccess: {
                blockPublicPolicy: true,
                restrictPublicBuckets: true,
                blockPublicAcls: false,
                ignorePublicAcls: false
            },
            encryption: BucketEncryption.KMS,
            encryptionKey: bucketKMSKey,
            enforceSSL: true,
        });
        dependencies.push(matterAuditLoggingBucket);

        // Enable ObjectLock on S3 Bucket which makes objects write-once-read-many
        const cfnBucket = matterAuditLoggingBucket.node.defaultChild as CfnBucket;
        cfnBucket.addPropertyOverride("ObjectLockEnabled", true);
        cfnBucket.addPropertyOverride(
            "ObjectLockConfiguration.ObjectLockEnabled",
            "Enabled"
        );
        cfnBucket.addPropertyOverride(
            "ObjectLockConfiguration.Rule.DefaultRetention.Mode",
            "GOVERNANCE"
        );
        cfnBucket.addPropertyOverride(
            "ObjectLockConfiguration.Rule.DefaultRetention.Days",
            RetentionDays.FIVE_YEARS
        );

        // Grant Auditor role access to bucket
        matterAuditLoggingBucket.grantRead(
            new ArnPrincipal(this.matterAuditorRole.roleArn))

        // Add Lifecycle rule to move objects to Glacier after 2 months and keep them for 5 years
        matterAuditLoggingBucket.addLifecycleRule({
            id: 'MatterAuditLogsArchivingToGlacier',
            enabled: true,
            expiration: Duration.days(RetentionDays.FIVE_YEARS),
            transitions: [
                {
                    transitionAfter: Duration.days(RetentionDays.TWO_MONTHS),
                    storageClass: StorageClass.GLACIER,
                },
            ],
        });

        dependencies.push(matterAuditLoggingBackupPlan.addSelection("S3BackupSelection", {
            resources: [BackupResource.fromArn(matterAuditLoggingBucket.bucketArn)],
            role: this.matterAuditLoggingBackupRole
        }));

        return [matterAuditLoggingBucket, dependencies];
    }

    // Creates the S3 bucket that will hold the CRLs for the Matter PKI.
    private createMatterCrlBucket(name: string): Bucket {
        const matterCrlBucket = new Bucket(this, name, {
            versioned: true,
            blockPublicAccess: {
                blockPublicPolicy: true,
                restrictPublicBuckets: true,
                blockPublicAcls: true,
                ignorePublicAcls: true
            },
            encryption: BucketEncryption.S3_MANAGED,
            enforceSSL: true,
        });

        matterCrlBucket.addToResourcePolicy(
            new PolicyStatement({
                actions: ["s3:GetBucketAcl",
                    "s3:GetBucketLocation",
                    "s3:PutObject",
                    "s3:PutObjectAcl"],
                effect: Effect.ALLOW,
                resources: [matterCrlBucket.bucketArn, matterCrlBucket.arnForObjects('*')],
                principals: [new ServicePrincipal('acm-pca.amazonaws.com')]
            })
        );

        new CfnOutput(this, 'CrlBucketUrl', {
            value: matterCrlBucket.bucketWebsiteUrl,
            description: 'The url of the S3 Bucket used for storing CRLs',
        });

        new CfnOutput(this, 'CrlBucketName', {
            value: matterCrlBucket.bucketName,
            description: 'The name of the S3 Bucket used for storing CRLs',
        });

        return matterCrlBucket;
    }

    // Creates the CloudWatch LogGroup where matter PKI audit logs will be filtered and displayed.
    public createAuditLogGroup(prefix: string, root: boolean, matterAuditLoggingBucket: Bucket, matterAuditLoggingBackupPlan: BackupPlan): [LogGroup, IConstruct[]] {
        const dependencies: IConstruct[] = []

        const logGroup = new LogGroup(this, prefix + "MatterAudit", {
            logGroupName: prefix + "MatterAudit",
            retention: RetentionDays.TWO_MONTHS
        });

        dependencies.push(logGroup);

        // Grant Auditor role access to LogGroup
        const logGroupActions = ["logs:Describe*",
            "logs:Get*",
            "logs:List*",
            "logs:StartQuery",
            "logs:StopQuery",
            "logs:TestMetricFilter",
            "logs:FilterLogEvents"]
        logGroup.grant(this.matterAuditorRole, ...logGroupActions);
        if (this.matterAuditorRole.node.tryFindChild('Policy'))
            dependencies.push(this.matterAuditorRole.node.tryFindChild('Policy') as IConstruct);

        // Filter LogGroup to contain only Matter relevant events
        dependencies.push(this.createMetricFilter(logGroup, 'AllPCAEventsFilter', '{ ($.eventSource = "acm-pca.amazonaws.com") }'));
        dependencies.push(this.createMetricFilter(logGroup, 'MatterAuditLoggingBucketFilter',
                          '{ ($.eventSource= "s3.amazonaws.com") && ($.requestParameters.bucketName = "' + matterAuditLoggingBucket.bucketName + '*") }'));
        dependencies.push(this.createMetricFilter(logGroup, 'MatterTaggedFilter', MatterStack.matterPKITag));
        if (root) {
            dependencies.push(this.createMetricFilter(logGroup, 'MatterPAARoleFilter', 'iam.amazonaws.com ' + this.matterManagePAARole.roleName));
            dependencies.push(this.createMetricFilter(logGroup, 'MatterPAIRoleFilter', 'iam.amazonaws.com ' + this.matterIssuePAIRole.roleName));
        } else {
            dependencies.push(this.createMetricFilter(logGroup, 'MatterIssueDACRoleFilter', 'iam.amazonaws.com ' + this.matterIssueDACRole.roleName));
        }
        dependencies.push(this.createMetricFilter(logGroup, 'MatterAuditorRoleFilter', 'iam.amazonaws.com ' + this.matterAuditorRole.roleName));
        dependencies.push(this.createMetricFilter(logGroup, 'MatterAuditLoggingBackupRoleFilter', 'iam.amazonaws.com ' + this.matterAuditLoggingBackupRole.roleName));
        dependencies.push(this.createMetricFilter(logGroup, 'MatterAuditLoggingBackupPlanFilter', 'backup.amazonaws.com ' + matterAuditLoggingBackupPlan.backupPlanId));

        if (root) {
            new CfnOutput(this, 'LogGroupName', {
                value: logGroup.logGroupName,
                description: 'The name of the CloudWatch LogGroup',
            });
        }

        return [logGroup, dependencies];
    }

    // Creates the CloudTrail for recording AWS events which will be stored in S3
    public createAuditCloudTrail(prefix: string, root: boolean, auditLogGroup: LogGroup, matterAuditLoggingBucket: Bucket): [Trail, IConstruct[]] {
        const dependencies: IConstruct[] = [];

        const trail = new Trail(this, prefix + 'MatterAuditTrail', {
            sendToCloudWatchLogs: true,
            enableFileValidation: true,
            bucket: matterAuditLoggingBucket,
            cloudWatchLogGroup: auditLogGroup,
            encryptionKey: matterAuditLoggingBucket.encryptionKey
        });
        dependencies.push(trail);

        const role = trail.node.findChild('LogsRole') as Role
        const rolePolicy = role.node.findChild("DefaultPolicy") as Policy;
        dependencies.push(rolePolicy);

        const s3EventSelector: S3EventSelector = {
            bucket: matterAuditLoggingBucket,
        };
        const bucketPolicy = matterAuditLoggingBucket.node.findChild('Policy') as Policy;
        dependencies.push(bucketPolicy);

        trail.addS3EventSelector([s3EventSelector]);

        if (root) {
            new CfnOutput(this, 'CloudTrailArn', {
                value: trail.trailArn,
                description: 'The ARN of the CloudTrail',
            });
        }

        return [trail, dependencies];
    }

    private createMetricFilter(logGroup: LogGroup, metricName: string, metricPattern: string): IConstruct {
        return new MetricFilter(this, metricName, {
            metricName: metricName,
            filterPattern: {
                logPatternString: metricPattern
            },
            logGroup: logGroup,
            metricNamespace: 'CloudTrail'
        });
    }

    private createPcaValidityInstance(validityInDays: number, validityEndDate: string): ICfnRuleConditionExpression {
        const useValidityEndDate = new CfnCondition(this, 'ValidityEndDateWasProvided', {
            expression: Fn.conditionNot(Fn.conditionEquals(validityEndDate, ''))
        });
        return Fn.conditionIf(useValidityEndDate.logicalId,
                              {Type: "END_DATE", Value: validityEndDate},
                              {Type: "DAYS", Value: validityInDays});
    }

    private createPcaValidityStrings(validityInDays: number, validityEndDate: string): [ICfnRuleConditionExpression, ICfnRuleConditionExpression] {
        const useValidityEndDate = new CfnCondition(this, 'ValidityEndDateWasProvided', {
            expression: Fn.conditionNot(Fn.conditionEquals(validityEndDate, ''))
        });
        return [Fn.conditionIf(useValidityEndDate.logicalId, "END_DATE", "DAYS"),
                Fn.conditionIf(useValidityEndDate.logicalId, validityEndDate, validityInDays)];
    }

    private createPAA(commonName: string,
                      crlBucketName: string,
                      organization: string,
                      organizationalUnit: string,
                      validity: ICfnRuleConditionExpression,
                      vendorId: string): CfnCertificateAuthorityActivation {

        const customAttributes = [
            { // Subject can either have standard attributes or custom attributes but not both.
                ObjectIdentifier: "2.5.4.3",                // commonName
                Value: commonName
            },
            {
                ObjectIdentifier: "1.3.6.1.4.1.37244.2.1",  // VendorID, matter-oid-vid
                Value: vendorId
            },
            {
                ObjectIdentifier: "2.5.4.10",               // organization
                Value: organization
            }
        ];

        const customAttributesWithOU = [
            { // Subject can either have standard attributes or custom attributes but not both.
                ObjectIdentifier: "2.5.4.3",                // commonName
                Value: commonName
            },
            {
                ObjectIdentifier: "1.3.6.1.4.1.37244.2.1",  // VendorID, matter-oid-vid
                Value: vendorId
            },
            {
                ObjectIdentifier: "2.5.4.10",               // organization
                Value: organization
            },
            {
                ObjectIdentifier: "2.5.4.11",               // organizationalUnit
                Value: organizationalUnit
            }
        ];

        const useCustomAttrsWithOU = new CfnCondition(this, 'OrgUnitWasProvided', {
           expression: Fn.conditionNot(Fn.conditionEquals(organizationalUnit, ''))
        });

        const cfnCA = new pca.CfnCertificateAuthority(this, 'CA-PAA', {
            type: 'ROOT',
            keyAlgorithm: 'EC_prime256v1',
            signingAlgorithm: 'SHA256WITHECDSA',
            keyStorageSecurityStandard: 'FIPS_140_2_LEVEL_3_OR_HIGHER',
            revocationConfiguration: {
                crlConfiguration: {
                    enabled: true,
                    expirationInDays: 90,
                    s3ObjectAcl: "BUCKET_OWNER_FULL_CONTROL",
                    s3BucketName: crlBucketName,
                    crlDistributionPointExtensionConfiguration: {
                        omitExtension: true
                    }
                }
            },
            subject: {
                customAttributes: Fn.conditionIf(useCustomAttrsWithOU.logicalId, customAttributesWithOU, customAttributes)
            },
            tags: [
                { key: "matterCAType", value: "paa" },
                { key: MatterStack.matterPKITag, value: ""  }
            ],
        });

        // Staying on safe side here.
        cfnCA.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;
        cfnCA.cfnOptions.updateReplacePolicy = CfnDeletionPolicy.RETAIN;

        const cfnCaCert = new pca.CfnCertificate(this, 'Cert-PAA', {
            certificateAuthorityArn: cfnCA.attrArn,
            certificateSigningRequest: cfnCA.attrCertificateSigningRequest,
            signingAlgorithm: 'SHA256WITHECDSA',
            validity: validity,
            // This template comes with keyCertSign, cRLSign, and digitalSignature Key Usage bits set.
            templateArn: "arn:aws:acm-pca:::template/RootCACertificate_APIPassthrough/V1"
        });

        new CfnOutput(this, 'PAACertArn', {
            value: cfnCaCert.attrArn,
            description: 'The ARN of the PAA certificate',
        });

        new CfnOutput(this, 'PAACertLink', {
            value:"https://console.aws.amazon.com/acm-pca/home?region=" + this.region + "#/details?arn=" + cfnCA.attrArn + "&tab=certificate",
            description: 'The link to the PAA certificate in the AWS Private CA console',
        });

        new CfnOutput(this, 'PAA', {
            value: "VID=" + vendorId + " CN=" + commonName + " " + cfnCA.attrArn,
            description: 'The ARN of the PAA',
        });

        return new pca.CfnCertificateAuthorityActivation(this, 'CertActivation' + '-PAA', {
            certificateAuthorityArn: cfnCA.attrArn,
            certificate: cfnCaCert.attrCertificate,
            status: "ACTIVE"
        });
    }

    private createPAI(commonName: string,
                      crlBucketName: string,
                      organization: string,
                      organizationalUnit: ICfnConditionExpression,
                      organizationalUnitSet: CfnCondition,
                      validity: [ICfnConditionExpression, ICfnConditionExpression],
                      vendorId: string,
                      paiId: number,
                      productIds: string[],
                      productIdsSet: CfnCondition,
                      parentCAArn: string,
                      parentRegion: string,
                      parentPem: string): CfnCertificateAuthorityActivation {

        const id = '-PAI-' + paiId!;

        const pid = Fn.conditionIf(productIdsSet.logicalId, Fn.select(paiId, productIds), '');

        const customAttributes = [
            { // Subject can either have standard attributes or custom attributes but not both.
                ObjectIdentifier: "2.5.4.3",                // commonName
                Value: commonName
            },
            {
                ObjectIdentifier: "1.3.6.1.4.1.37244.2.1",  // VendorID, matter-oid-vid
                Value: vendorId
            },
            {
                ObjectIdentifier: "2.5.4.10",            // organization
                Value: organization
            }
        ];

        const customAttributesWithPid = [
            { // Subject can either have standard attributes or custom attributes but not both.
                ObjectIdentifier: "2.5.4.3",                // commonName
                Value: commonName
            },
            {
                ObjectIdentifier: "1.3.6.1.4.1.37244.2.1",  // VendorID, matter-oid-vid
                Value: vendorId
            },
            {
                ObjectIdentifier: "2.5.4.10",            // organization
                Value: organization
            },
            {
                ObjectIdentifier: "1.3.6.1.4.1.37244.2.2",  // ProductID, matter-oid-pid
                Value: pid
            }
        ];

        const customAttributesWithOu = [
            { // Subject can either have standard attributes or custom attributes but not both.
                ObjectIdentifier: "2.5.4.3",                // commonName
                Value: commonName
            },
            {
                ObjectIdentifier: "1.3.6.1.4.1.37244.2.1",  // VendorID, matter-oid-vid
                Value: vendorId
            },
            {
                ObjectIdentifier: "2.5.4.10",            // organization
                Value: organization
            },
            {
                ObjectIdentifier: "2.5.4.11",            // organizationalUnit
                Value: organizationalUnit
            }
        ];

        const customAttributesWithOuPid = [
            { // Subject can either have standard attributes or custom attributes but not both.
                ObjectIdentifier: "2.5.4.3",                // commonName
                Value: commonName
            },
            {
                ObjectIdentifier: "1.3.6.1.4.1.37244.2.1",  // VendorID, matter-oid-vid
                Value: vendorId
            },
            {
                ObjectIdentifier: "2.5.4.10",            // organization
                Value: organization
            },
            {
                ObjectIdentifier: "2.5.4.11",            // organizationalUnit
                Value: organizationalUnit
            },
            {
                ObjectIdentifier: "1.3.6.1.4.1.37244.2.2",  // ProductID, matter-oid-pid
                Value: pid
            }
        ];

        const pidAndOuSet = new CfnCondition(this, `PaiPidAndOuWereProvided-${paiId}`, {
            expression: Fn.conditionAnd(productIdsSet, organizationalUnitSet)
        });
        const targetCustomAttributes =
            Fn.conditionIf(pidAndOuSet.logicalId, customAttributesWithOuPid,
                Fn.conditionIf(productIdsSet.logicalId, customAttributesWithPid,
                    Fn.conditionIf(organizationalUnitSet.logicalId, customAttributesWithOu, customAttributes)));

        const cfnCA = new pca.CfnCertificateAuthority(this, 'CA' + id, {
            type: 'SUBORDINATE',
            keyAlgorithm: 'EC_prime256v1',
            signingAlgorithm: 'SHA256WITHECDSA',
            keyStorageSecurityStandard: 'FIPS_140_2_LEVEL_3_OR_HIGHER',
            subject: {
                customAttributes: targetCustomAttributes
            },
            revocationConfiguration: {
                crlConfiguration: {
                    enabled: true,
                    expirationInDays: 90,
                    s3ObjectAcl: "BUCKET_OWNER_FULL_CONTROL",
                    s3BucketName: crlBucketName,
                    crlDistributionPointExtensionConfiguration: {
                        omitExtension: true
                    }
                }
            },
            tags: [
                { key: MatterStack.matterCATypeTag, value: "pai" },
                { key: MatterStack.matterPKITag, value: "" }
            ]
        });

        // Staying on safe side here.
        cfnCA.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;
        cfnCA.cfnOptions.updateReplacePolicy = CfnDeletionPolicy.RETAIN;

        // CDK workaround.
        //
        // We need to remove '\n' characters from the CSR (which must be present). Otherwise, AwsCustomResource, while formatting Lambda
        // input JSON string, would add them as is, ending up with an invalid JSON. Instead, they need to be escaped like '\\n'.
        //
        // We could just use Fn.join('\\n', Fn.split('\n', ...)) if AwsCustomResource didn't escape those literals into  '\\\\n' and
        // '\\n', which prevents Fn.split() from finding any characters. We also cannot pass in any Token as a delimiter, it's not
        // supported.
        //
        // Here we simply write CSR with escaped newline characters into an SSM parameter, and then pass its value to AwsCustomResource.
        // This way we avoid any issues.
        const caCertCsrParam = new StringParameter(this, this.node.id + '-PAI-CSR-' + paiId, {
            parameterName: '/' + this.node.id + '/PAI-CSR' + paiId,
            stringValue: Fn.join('\\n', Fn.split('\n', cfnCA.attrCertificateSigningRequest))
        });

        const caCertArn = new AwsCustomResource(this, 'Certificate' + id, {
            onUpdate: {
                service: 'ACMPCA',
                action: 'issueCertificate',
                parameters: {
                    CertificateAuthorityArn: parentCAArn,
                    Csr: caCertCsrParam.stringValue,
                    SigningAlgorithm: 'SHA256WITHECDSA',
                    Validity: {
                        Type: validity[0],
                        Value: Token.asNumber(validity[1])
                    },
                    TemplateArn: "arn:aws:acm-pca:::template/BlankSubordinateCACertificate_PathLen0_APIPassthrough/V1",
                    // Currently the only way to only set keyCertSign and cRLSign bits (and not digitalSignature) and get Matter-compatible certificate.
                    ApiPassthrough: {
                        Extensions: {
                            CustomExtensions: [
                                {
                                    ObjectIdentifier: '2.5.29.15',  // KeyUsage
                                    Value: 'AwIBBg==',              // bitstring with 7 bits 0000 011
                                    Critical: true
                                }
                            ]
                        }
                    }
                },
                region: parentRegion,
                physicalResourceId: {id: Date.now().toString()} // Update physical id to always fetch the latest version
            },
            policy: {
                statements: [
                    new PolicyStatement({
                        resources: [parentCAArn],
                        actions: ['acm-pca:IssueCertificate'],
                        effect: Effect.ALLOW,
                    }),
                ],
            },
            installLatestAwsSdk: true   // Standard, provided by Lambda, version doesn't have CustomExtensions!
        }).getResponseField('CertificateArn');

        const certificate = new AwsCustomResource(this, 'CertificatePem' + id, {
            onUpdate: {
                service: 'ACMPCA',
                action: 'getCertificate',
                parameters: {
                    CertificateArn: caCertArn,
                    CertificateAuthorityArn: parentCAArn
                },
                region: parentRegion,
                physicalResourceId: {id: Date.now().toString()} // Update physical id to always fetch the latest version
            },
            policy: {
                statements: [
                    new PolicyStatement({
                        resources: [parentCAArn],
                        actions: ['acm-pca:GetCertificate'],
                        effect: Effect.ALLOW,
                    }),
                ],
            },
            installLatestAwsSdk: true
        }).getResponseField('Certificate');

        const caCertArnOutputName = 'CertArnPAI' + paiId!;

        new CfnOutput(this, caCertArnOutputName, {
            value: caCertArn,
            description: 'The certificate Arn for PAI' + paiId!,
        });

        const caArnOutputName = 'PAI' + paiId!;

        new CfnOutput(this, caArnOutputName, {
            value: "VID=" + vendorId + " PID=" + pid + " CN=" + commonName + " " + cfnCA.attrArn,
            description: 'The ARN of PAI' + paiId!,
        });

        const certLinkOutputName = 'CertLinkPAI' + paiId!;

        new CfnOutput(this, certLinkOutputName, {
            value:"https://console.aws.amazon.com/acm-pca/home?region=" + this.region + "#/details?arn=" + cfnCA.attrArn + "&tab=certificate",
            description: 'The link to the PAI certificate in the AWS Private CA console',
        });

        return new pca.CfnCertificateAuthorityActivation(this, 'CertActivation' + id, {
            certificateAuthorityArn: cfnCA.attrArn,
            certificate: certificate,
            certificateChain: parentPem,
            status: "ACTIVE"
        });
    }

    private getCertificatePem(id: string, parentCAArn: string, parentRegion: string) {
        // Need to remove newline characters as we're going to pass it into JSON attribute.
        return new AwsCustomResource(this, 'PaaPem' + id, {
            onUpdate: {
                service: 'ACMPCA',
                action: 'getCertificateAuthorityCertificate',
                parameters: {
                    CertificateAuthorityArn: parentCAArn
                },
                region: parentRegion,
                physicalResourceId: {id: Date.now().toString()} // Update physical id to always fetch the latest version
            },
            policy: {
                statements: [
                    new PolicyStatement({
                        resources: [parentCAArn],
                        actions: ['acm-pca:GetCertificateAuthorityCertificate'],
                        effect: Effect.ALLOW,
                    }),
                ],
            },
            installLatestAwsSdk: true
        }).getResponseField('Certificate');
    }

    private createDacIssuingLambda(dacValidityInDays: number) {
        const lambdaTimeout = Duration.minutes(1);
        const lambdaBatchSize = 5;
        const pcaIssueCertificateMaxTps = 25;
        const lambdaAvgExecTimeInSeconds = 11;

        const s3ToSqs = new S3ToSqs(this, 'DacInputS3ToSQS', {
            s3EventFilters: [
                {prefix: '', suffix: '.csr'}
            ],
            queueProps: {
                visibilityTimeout: Duration.minutes(lambdaTimeout.toMinutes() * 6),  // Lambda's recommended at least 6 times.
            }
        });
        Tags.of(s3ToSqs.sqsQueue).add(MatterStack.matterPKITag, "");
        Tags.of(s3ToSqs.deadLetterQueue!.queue).add(MatterStack.matterPKITag, "");
        Tags.of(s3ToSqs.s3Bucket!).add(MatterStack.matterPKITag, "");
        Tags.of(s3ToSqs.s3LoggingBucket!).add(MatterStack.matterPKITag, "");

        s3ToSqs.s3LoggingBucket?.grantRead(this.matterAuditorRole);

        const sqsToLambda = new SqsToLambda(this, 'SqsToDacIssuingLambda', {
            existingQueueObj: s3ToSqs.sqsQueue,
            lambdaFunctionProps: {
                // https://docs.aws.amazon.com/lambda/latest/dg/java-package.html#java-package-gradle
                code: lambda.Code.fromAsset('lambda/build/distributions/lambda.zip'),
                runtime: lambda.Runtime.JAVA_11,
                handler: 'com.sample.Handler',

                timeout: lambdaTimeout,
                memorySize: 512,
                reservedConcurrentExecutions: pcaIssueCertificateMaxTps / lambdaBatchSize * lambdaAvgExecTimeInSeconds,

                logRetention: RetentionDays.TWO_MONTHS,
                environment: {
                    "dacValidityInDays": dacValidityInDays.toString()
                }
            },
            maxReceiveCount: 5, // Number of retries
            sqsEventSourceProps: {
                reportBatchItemFailures: true,
                batchSize: lambdaBatchSize,
                enabled: true
            }
        });
        Tags.of(sqsToLambda.lambdaFunction).add(MatterStack.matterPKITag, "");

        s3ToSqs.s3Bucket!.grantReadWrite(sqsToLambda.lambdaFunction);

        for (const stmt of this.getPolicyStatementsForDACIssuance()) {
            sqsToLambda.lambdaFunction.addToRolePolicy(stmt);
        }

        const auditorLogGroupActions = ["logs:Describe*",
            "logs:Get*",
            "logs:List*",
            "logs:StartQuery",
            "logs:StopQuery",
            "logs:TestMetricFilter",
            "logs:FilterLogEvents"]
        sqsToLambda.lambdaFunction.logGroup.grant(this.matterAuditorRole, ...auditorLogGroupActions);

        new CfnOutput(this, 'DACIssuingLambdaFunctionName', {
            value: sqsToLambda.lambdaFunction.functionName,
            description: 'The name of the Lambda Function that issues DACs',
        });
    }
}