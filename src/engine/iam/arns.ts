/** ARN builders for IAM checks, in the real formats. */

type Target = { id: string; name: string; region: string; config: Record<string, unknown> };

/** e.g. arn:aws:ec2:us-east-1:123456789012:instance/i-0abc… */
export const ec2Arn = (kind: string) => (r: Target, account: string) => `arn:aws:ec2:${r.region}:${account}:${kind}/${r.id}`;

/** e.g. arn:aws:s3:::my-bucket (bucket ARNs have no region or account). */
export const s3BucketArn = (r: Target) => `arn:aws:s3:::${r.name || r.id}`;

export const s3ObjectArn = (bucket: string, key: string) => `arn:aws:s3:::${bucket}/${key}`;
