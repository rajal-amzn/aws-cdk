import * as iam from '@aws-cdk/aws-iam';
import * as kms from '@aws-cdk/aws-kms';
import { IResource, RemovalPolicy, Resource, SecretValue, Stack, Token } from '@aws-cdk/core';
import { IConstruct, Construct } from 'constructs';
import { ResourcePolicy } from './policy';
import { RotationSchedule, RotationScheduleOptions } from './rotation-schedule';
import * as secretsmanager from './secretsmanager.generated';

/**
 * A secret in AWS Secrets Manager.
 */
export interface ISecret extends IResource {
  /**
   * The customer-managed encryption key that is used to encrypt this secret, if any. When not specified, the default
   * KMS key for the account and region is being used.
   */
  readonly encryptionKey?: kms.IKey;

  /**
   * The ARN of the secret in AWS Secrets Manager. Will return the full ARN if available, otherwise a partial arn.
   * For secrets imported by the deprecated `fromSecretName`, it will return the `secretName`.
   * @attribute
   */
  readonly secretArn: string;

  /**
   * The full ARN of the secret in AWS Secrets Manager, which is the ARN including the Secrets Manager-supplied 6-character suffix.
   * This is equal to `secretArn` in most cases, but is undefined when a full ARN is not available (e.g., secrets imported by name).
   */
  readonly secretFullArn?: string;

  /**
   * The name of the secret
   */
  readonly secretName: string;

  /**
   * Retrieve the value of the stored secret as a `SecretValue`.
   * @attribute
   */
  readonly secretValue: SecretValue;

  /**
   * Interpret the secret as a JSON object and return a field's value from it as a `SecretValue`.
   */
  secretValueFromJson(key: string): SecretValue;

  /**
   * Grants reading the secret value to some role.
   *
   * @param grantee       the principal being granted permission.
   * @param versionStages the version stages the grant is limited to. If not specified, no restriction on the version
   *                      stages is applied.
   */
  grantRead(grantee: iam.IGrantable, versionStages?: string[]): iam.Grant;

  /**
   * Grants writing and updating the secret value to some role.
   *
   * @param grantee       the principal being granted permission.
   */
  grantWrite(grantee: iam.IGrantable): iam.Grant;

  /**
   * Adds a rotation schedule to the secret.
   */
  addRotationSchedule(id: string, options: RotationScheduleOptions): RotationSchedule;

  /**
   * Adds a statement to the IAM resource policy associated with this secret.
   *
   * If this secret was created in this stack, a resource policy will be
   * automatically created upon the first call to `addToResourcePolicy`. If
   * the secret is imported, then this is a no-op.
   */
  addToResourcePolicy(statement: iam.PolicyStatement): iam.AddToResourcePolicyResult;

  /**
   * Denies the `DeleteSecret` action to all principals within the current
   * account.
   */
  denyAccountRootDelete(): void;

  /**
   * Attach a target to this secret.
   *
   * @param target The target to attach.
   * @returns An attached secret
   */
  attach(target: ISecretAttachmentTarget): ISecret;
}

/**
 * The properties required to create a new secret in AWS Secrets Manager.
 */
export interface SecretProps {
  /**
   * An optional, human-friendly description of the secret.
   *
   * @default - No description.
   */
  readonly description?: string;

  /**
   * The customer-managed encryption key to use for encrypting the secret value.
   *
   * @default - A default KMS key for the account and region is used.
   */
  readonly encryptionKey?: kms.IKey;

  /**
   * Configuration for how to generate a secret value.
   *
   * @default - 32 characters with upper-case letters, lower-case letters, punctuation and numbers (at least one from each
   * category), per the default values of ``SecretStringGenerator``.
   */
  readonly generateSecretString?: SecretStringGenerator;

  /**
   * A name for the secret. Note that deleting secrets from SecretsManager does not happen immediately, but after a 7 to
   * 30 days blackout period. During that period, it is not possible to create another secret that shares the same name.
   *
   * @default - A name is generated by CloudFormation.
   */
  readonly secretName?: string;

  /**
   * Policy to apply when the secret is removed from this stack.
   *
   * @default - Not set.
   */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * Attributes required to import an existing secret into the Stack.
 * One ARN format (`secretArn`, `secretCompleteArn`, `secretPartialArn`) must be provided.
 */
export interface SecretAttributes {
  /**
   * The encryption key that is used to encrypt the secret, unless the default SecretsManager key is used.
   */
  readonly encryptionKey?: kms.IKey;

  /**
   * The ARN of the secret in SecretsManager.
   * Cannot be used with `secretCompleteArn` or `secretPartialArn`.
   * @deprecated use `secretCompleteArn` or `secretPartialArn` instead.
   */
  readonly secretArn?: string;

  /**
   * The complete ARN of the secret in SecretsManager. This is the ARN including the Secrets Manager 6-character suffix.
   * Cannot be used with `secretArn` or `secretPartialArn`.
   */
  readonly secretCompleteArn?: string;

  /**
   * The partial ARN of the secret in SecretsManager. This is the ARN without the Secrets Manager 6-character suffix.
   * Cannot be used with `secretArn` or `secretCompleteArn`.
   */
  readonly secretPartialArn?: string;
}

/**
 * The common behavior of Secrets. Users should not use this class directly, and instead use ``Secret``.
 */
abstract class SecretBase extends Resource implements ISecret {
  public abstract readonly encryptionKey?: kms.IKey;
  public abstract readonly secretArn: string;
  public abstract readonly secretName: string;

  protected abstract readonly autoCreatePolicy: boolean;

  private policy?: ResourcePolicy;

  public get secretFullArn(): string | undefined { return this.secretArn; }

  public grantRead(grantee: iam.IGrantable, versionStages?: string[]): iam.Grant {
    // @see https://docs.aws.amazon.com/secretsmanager/latest/userguide/auth-and-access_identity-based-policies.html

    const result = iam.Grant.addToPrincipal({
      grantee,
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resourceArns: [this.arnForPolicies],
      scope: this,
    });
    if (versionStages != null && result.principalStatement) {
      result.principalStatement.addCondition('ForAnyValue:StringEquals', {
        'secretsmanager:VersionStage': versionStages,
      });
    }

    if (this.encryptionKey) {
      // @see https://docs.aws.amazon.com/kms/latest/developerguide/services-secrets-manager.html
      this.encryptionKey.grantDecrypt(
        new kms.ViaServicePrincipal(`secretsmanager.${Stack.of(this).region}.amazonaws.com`, grantee.grantPrincipal),
      );
    }

    return result;
  }

  public grantWrite(grantee: iam.IGrantable): iam.Grant {
    // See https://docs.aws.amazon.com/secretsmanager/latest/userguide/auth-and-access_identity-based-policies.html
    const result = iam.Grant.addToPrincipal({
      grantee,
      actions: ['secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecret'],
      resourceArns: [this.arnForPolicies],
      scope: this,
    });

    if (this.encryptionKey) {
      // See https://docs.aws.amazon.com/kms/latest/developerguide/services-secrets-manager.html
      this.encryptionKey.grantEncrypt(
        new kms.ViaServicePrincipal(`secretsmanager.${Stack.of(this).region}.amazonaws.com`, grantee.grantPrincipal),
      );
    }

    return result;
  }

  public get secretValue() {
    return this.secretValueFromJson('');
  }

  public secretValueFromJson(jsonField: string) {
    return SecretValue.secretsManager(this.secretArn, { jsonField });
  }

  public addRotationSchedule(id: string, options: RotationScheduleOptions): RotationSchedule {
    return new RotationSchedule(this, id, {
      secret: this,
      ...options,
    });
  }

  public addToResourcePolicy(statement: iam.PolicyStatement): iam.AddToResourcePolicyResult {
    if (!this.policy && this.autoCreatePolicy) {
      this.policy = new ResourcePolicy(this, 'Policy', { secret: this });
    }

    if (this.policy) {
      this.policy.document.addStatements(statement);
      return { statementAdded: true, policyDependable: this.policy };
    }
    return { statementAdded: false };
  }

  protected validate(): string[] {
    const errors = super.validate();
    errors.push(...this.policy?.document.validateForResourcePolicy() || []);
    return errors;
  }

  public denyAccountRootDelete() {
    this.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:DeleteSecret'],
      effect: iam.Effect.DENY,
      resources: ['*'],
      principals: [new iam.AccountRootPrincipal()],
    }));
  }

  /**
   * Provides an identifier for this secret for use in IAM policies. Typically, this is just the secret ARN.
   * However, secrets imported by name require a different format.
   */
  protected get arnForPolicies() { return this.secretArn; }

  /**
   * Attach a target to this secret
   *
   * @param target The target to attach
   * @returns An attached secret
   */
  public attach(target: ISecretAttachmentTarget): ISecret {
    const id = 'Attachment';
    const existing = this.node.tryFindChild(id);

    if (existing) {
      throw new Error('Secret is already attached to a target.');
    }

    return new SecretTargetAttachment(this, id, {
      secret: this,
      target,
    });
  }
}

/**
 * Creates a new secret in AWS SecretsManager.
 */
export class Secret extends SecretBase {

  /** @deprecated use `fromSecretCompleteArn` or `fromSecretPartialArn` */
  public static fromSecretArn(scope: Construct, id: string, secretArn: string): ISecret {
    const attrs = arnIsComplete(secretArn) ? { secretCompleteArn: secretArn } : { secretPartialArn: secretArn };
    return Secret.fromSecretAttributes(scope, id, attrs);
  }

  /** Imports a secret by complete ARN. The complete ARN is the ARN with the Secrets Manager-supplied suffix. */
  public static fromSecretCompleteArn(scope: Construct, id: string, secretCompleteArn: string): ISecret {
    return Secret.fromSecretAttributes(scope, id, { secretCompleteArn });
  }

  /** Imports a secret by partial ARN. The partial ARN is the ARN without the Secrets Manager-supplied suffix. */
  public static fromSecretPartialArn(scope: Construct, id: string, secretPartialArn: string): ISecret {
    return Secret.fromSecretAttributes(scope, id, { secretPartialArn });
  }

  /**
   * Imports a secret by secret name; the ARN of the Secret will be set to the secret name.
   * A secret with this name must exist in the same account & region.
   * @deprecated use `fromSecretNameV2`
   */
  public static fromSecretName(scope: Construct, id: string, secretName: string): ISecret {
    return new class extends SecretBase {
      public readonly encryptionKey = undefined;
      public readonly secretArn = secretName;
      public readonly secretName = secretName;
      protected readonly autoCreatePolicy = false;
      public get secretFullArn() { return undefined; }
      // Overrides the secretArn for grant* methods, where the secretArn must be in ARN format.
      // Also adds a wildcard to the resource name to support the SecretsManager-provided suffix.
      protected get arnForPolicies() {
        return Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          resourceName: this.secretName + '*',
          sep: ':',
        });
      }
    }(scope, id);
  }

  /**
   * Imports a secret by secret name.
   * A secret with this name must exist in the same account & region.
   * Replaces the deprecated `fromSecretName`.
   */
  public static fromSecretNameV2(scope: Construct, id: string, secretName: string): ISecret {
    return new class extends SecretBase {
      public readonly encryptionKey = undefined;
      public readonly secretName = secretName;
      public readonly secretArn = this.partialArn;
      protected readonly autoCreatePolicy = false;
      public get secretFullArn() { return undefined; }
      // Overrides the secretArn for grant* methods, where the secretArn must be in ARN format.
      // Also adds a wildcard to the resource name to support the SecretsManager-provided suffix.
      protected get arnForPolicies(): string {
        return this.partialArn + '-??????';
      }
      // Creates a "partial" ARN from the secret name. The "full" ARN would include the SecretsManager-provided suffix.
      private get partialArn(): string {
        return Stack.of(this).formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          resourceName: secretName,
          sep: ':',
        });
      }
    }(scope, id);
  }

  /**
   * Import an existing secret into the Stack.
   *
   * @param scope the scope of the import.
   * @param id    the ID of the imported Secret in the construct tree.
   * @param attrs the attributes of the imported secret.
   */
  public static fromSecretAttributes(scope: Construct, id: string, attrs: SecretAttributes): ISecret {
    let secretArn: string;
    let secretArnIsPartial: boolean;

    if (attrs.secretArn) {
      if (attrs.secretCompleteArn || attrs.secretPartialArn) {
        throw new Error('cannot use `secretArn` with `secretCompleteArn` or `secretPartialArn`');
      }
      secretArn = attrs.secretArn;
      secretArnIsPartial = false;
    } else {
      if ((attrs.secretCompleteArn && attrs.secretPartialArn) ||
          (!attrs.secretCompleteArn && !attrs.secretPartialArn)) {
        throw new Error('must use only one of `secretCompleteArn` or `secretPartialArn`');
      }
      [secretArn, secretArnIsPartial] = attrs.secretCompleteArn ? [attrs.secretCompleteArn, false] : [attrs.secretPartialArn!, true];
    }

    return new class extends SecretBase {
      public readonly encryptionKey = attrs.encryptionKey;
      public readonly secretArn = secretArn;
      public readonly secretName = parseSecretName(scope, secretArn);
      protected readonly autoCreatePolicy = false;
      public get secretFullArn() { return secretArnIsPartial ? undefined : secretArn; }
    }(scope, id);
  }

  public readonly encryptionKey?: kms.IKey;
  public readonly secretArn: string;
  public readonly secretName: string;

  protected readonly autoCreatePolicy = true;

  constructor(scope: Construct, id: string, props: SecretProps = {}) {
    super(scope, id, {
      physicalName: props.secretName,
    });

    if (props.generateSecretString &&
        (props.generateSecretString.secretStringTemplate || props.generateSecretString.generateStringKey) &&
        !(props.generateSecretString.secretStringTemplate && props.generateSecretString.generateStringKey)) {
      throw new Error('`secretStringTemplate` and `generateStringKey` must be specified together.');
    }

    const resource = new secretsmanager.CfnSecret(this, 'Resource', {
      description: props.description,
      kmsKeyId: props.encryptionKey && props.encryptionKey.keyArn,
      generateSecretString: props.generateSecretString || {},
      name: this.physicalName,
    });

    if (props.removalPolicy) {
      resource.applyRemovalPolicy(props.removalPolicy);
    }

    this.secretArn = this.getResourceArnAttribute(resource.ref, {
      service: 'secretsmanager',
      resource: 'secret',
      resourceName: this.physicalName,
      sep: ':',
    });

    this.encryptionKey = props.encryptionKey;
    this.secretName = this.physicalName;

    // @see https://docs.aws.amazon.com/kms/latest/developerguide/services-secrets-manager.html#asm-authz
    const principal =
      new kms.ViaServicePrincipal(`secretsmanager.${Stack.of(this).region}.amazonaws.com`, new iam.AccountPrincipal(Stack.of(this).account));
    this.encryptionKey?.grantEncryptDecrypt(principal);
    this.encryptionKey?.grant(principal, 'kms:CreateGrant', 'kms:DescribeKey');
  }

  /**
   * Adds a target attachment to the secret.
   *
   * @returns an AttachedSecret
   *
   * @deprecated use `attach()` instead
   */
  public addTargetAttachment(id: string, options: AttachedSecretOptions): SecretTargetAttachment {
    return new SecretTargetAttachment(this, id, {
      secret: this,
      ...options,
    });
  }
}

/**
 * A secret attachment target.
 */
export interface ISecretAttachmentTarget {
  /**
   * Renders the target specifications.
   */
  asSecretAttachmentTarget(): SecretAttachmentTargetProps;
}

/**
 * The type of service or database that's being associated with the secret.
 */
export enum AttachmentTargetType {
  /**
   * A database instance
   *
   * @deprecated use RDS_DB_INSTANCE instead
   */
  INSTANCE = 'AWS::RDS::DBInstance',

  /**
   * A database cluster
   *
   * @deprecated use RDS_DB_CLUSTER instead
   */
  CLUSTER = 'AWS::RDS::DBCluster',

  /**
   * AWS::RDS::DBInstance
   */
  RDS_DB_INSTANCE = 'AWS::RDS::DBInstance',

  /**
   * AWS::RDS::DBCluster
   */
  RDS_DB_CLUSTER = 'AWS::RDS::DBCluster',

  /**
   * AWS::RDS::DBProxy
   */
  RDS_DB_PROXY = 'AWS::RDS::DBProxy',

  /**
   * AWS::Redshift::Cluster
   */
  REDSHIFT_CLUSTER = 'AWS::Redshift::Cluster',

  /**
   * AWS::DocDB::DBInstance
   */
  DOCDB_DB_INSTANCE = 'AWS::DocDB::DBInstance',

  /**
   * AWS::DocDB::DBCluster
   */
  DOCDB_DB_CLUSTER = 'AWS::DocDB::DBCluster'
}

/**
 * Attachment target specifications.
 */
export interface SecretAttachmentTargetProps {
  /**
   * The id of the target to attach the secret to.
   */
  readonly targetId: string;

  /**
   * The type of the target to attach the secret to.
   */
  readonly targetType: AttachmentTargetType;
}

/**
 * Options to add a secret attachment to a secret.
 *
 * @deprecated use `secret.attach()` instead
 */
export interface AttachedSecretOptions {
  /**
   * The target to attach the secret to.
   */
  readonly target: ISecretAttachmentTarget;
}

/**
 * Construction properties for an AttachedSecret.
 */
export interface SecretTargetAttachmentProps extends AttachedSecretOptions {
  /**
   * The secret to attach to the target.
   */
  readonly secret: ISecret;
}

export interface ISecretTargetAttachment extends ISecret {
  /**
   * Same as `secretArn`
   *
   * @attribute
   */
  readonly secretTargetAttachmentSecretArn: string;
}

/**
 * An attached secret.
 */
export class SecretTargetAttachment extends SecretBase implements ISecretTargetAttachment {

  public static fromSecretTargetAttachmentSecretArn(scope: Construct, id: string, secretTargetAttachmentSecretArn: string): ISecretTargetAttachment {
    class Import extends SecretBase implements ISecretTargetAttachment {
      public encryptionKey?: kms.IKey | undefined;
      public secretArn = secretTargetAttachmentSecretArn;
      public secretTargetAttachmentSecretArn = secretTargetAttachmentSecretArn;
      public secretName = parseSecretName(scope, secretTargetAttachmentSecretArn);
      protected readonly autoCreatePolicy = false;
    }

    return new Import(scope, id);
  }

  public readonly encryptionKey?: kms.IKey;
  public readonly secretArn: string;
  public readonly secretName: string;

  /**
   * @attribute
   */
  public readonly secretTargetAttachmentSecretArn: string;

  protected readonly autoCreatePolicy = true;

  constructor(scope: Construct, id: string, props: SecretTargetAttachmentProps) {
    super(scope, id);

    const attachment = new secretsmanager.CfnSecretTargetAttachment(this, 'Resource', {
      secretId: props.secret.secretArn,
      targetId: props.target.asSecretAttachmentTarget().targetId,
      targetType: props.target.asSecretAttachmentTarget().targetType,
    });

    this.encryptionKey = props.secret.encryptionKey;
    this.secretName = props.secret.secretName;

    // This allows to reference the secret after attachment (dependency).
    this.secretArn = attachment.ref;
    this.secretTargetAttachmentSecretArn = attachment.ref;
  }
}

/**
 * Configuration to generate secrets such as passwords automatically.
 */
export interface SecretStringGenerator {
  /**
   * Specifies that the generated password shouldn't include uppercase letters.
   *
   * @default false
   */
  readonly excludeUppercase?: boolean;

  /**
   * Specifies whether the generated password must include at least one of every allowed character type.
   *
   * @default true
   */
  readonly requireEachIncludedType?: boolean;

  /**
   * Specifies that the generated password can include the space character.
   *
   * @default false
   */
  readonly includeSpace?: boolean;

  /**
   * A string that includes characters that shouldn't be included in the generated password. The string can be a minimum
   * of ``0`` and a maximum of ``4096`` characters long.
   *
   * @default no exclusions
   */
  readonly excludeCharacters?: string;

  /**
   * The desired length of the generated password.
   *
   * @default 32
   */
  readonly passwordLength?: number;

  /**
   * Specifies that the generated password shouldn't include punctuation characters.
   *
   * @default false
   */
  readonly excludePunctuation?: boolean;

  /**
   * Specifies that the generated password shouldn't include lowercase letters.
   *
   * @default false
   */
  readonly excludeLowercase?: boolean;

  /**
   * Specifies that the generated password shouldn't include digits.
   *
   * @default false
   */
  readonly excludeNumbers?: boolean;

  /**
   * A properly structured JSON string that the generated password can be added to. The ``generateStringKey`` is
   * combined with the generated random string and inserted into the JSON structure that's specified by this parameter.
   * The merged JSON string is returned as the completed SecretString of the secret. If you specify ``secretStringTemplate``
   * then ``generateStringKey`` must be also be specified.
   */
  readonly secretStringTemplate?: string;

  /**
   * The JSON key name that's used to add the generated password to the JSON structure specified by the
   * ``secretStringTemplate`` parameter. If you specify ``generateStringKey`` then ``secretStringTemplate``
   * must be also be specified.
   */
  readonly generateStringKey?: string;
}

/** Parses the secret name from the ARN. */
function parseSecretName(construct: IConstruct, secretArn: string) {
  const resourceName = Stack.of(construct).parseArn(secretArn, ':').resourceName;
  if (resourceName) {
    // Can't operate on the token to remove the SecretsManager suffix, so just return the full secret name
    if (Token.isUnresolved(resourceName)) {
      return resourceName;
    }

    // Secret resource names are in the format `${secretName}-${6-character SecretsManager suffix}`
    // If there is no hyphen (or 6-character suffix) assume no suffix was provided, and return the whole name.
    const lastHyphenIndex = resourceName.lastIndexOf('-');
    const hasSecretsSuffix = lastHyphenIndex !== -1 && resourceName.substr(lastHyphenIndex + 1).length === 6;
    return hasSecretsSuffix ? resourceName.substr(0, lastHyphenIndex) : resourceName;
  }
  throw new Error('invalid ARN format; no secret name provided');
}

/** Performs a best guess if an ARN is complete, based on if it ends with a 6-character suffix. */
function arnIsComplete(secretArn: string): boolean {
  return Token.isUnresolved(secretArn) || /-[a-z0-9]{6}$/i.test(secretArn);
}
