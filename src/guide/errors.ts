/**
 * Plain-language explanations for the error codes learners will meet, used
 * by the guide to turn "it failed" into "here's what that means".
 */
export interface ErrorExplanation {
  meaning: string;
  fix: string;
}

const EXPLANATIONS: Record<string, ErrorExplanation> = {
  CannotDelete: {
    meaning: "Every VPC has a 'default' security group made by AWS, and it can't be deleted on its own.",
    fix: "Leave it, or remove its rules if you don't want it to allow anything. It goes away when the VPC is deleted.",
  },
  DefaultVpcAlreadyExists: {
    meaning: "This region already has a default VPC; there can only be one.",
    fix: "Use the existing one (describe-vpcs --filters Name=isDefault,Values=true), or delete it first.",
  },
  "InvalidGroup.NotFound": {
    meaning:
      "Either the security group ID doesn't exist in this region, or you tried to combine a security group and another resource from different VPCs.",
    fix: "Check the ID and region. Security groups only work with subnets, instances and other groups in the same VPC.",
  },
  DependencyViolation: {
    meaning: "Something else still uses this resource, so deleting or changing it would break that thing.",
    fix: "Open the resource's 'Used by' list, remove or detach those first, then try again.",
  },
  "InvalidSubnet.Range": {
    meaning: "The subnet's CIDR isn't usable: it's outside the VPC's range, or bigger than /16 or smaller than /28.",
    fix: "Pick a block between /16 and /28 inside the VPC's range, e.g. 10.0.1.0/24 for a 10.0.0.0/16 VPC.",
  },
  "InvalidSubnet.Conflict": {
    meaning: "The subnet's address range overlaps another subnet in the same VPC.",
    fix: "Choose a range nobody else uses, e.g. move from 10.0.1.0/24 to 10.0.2.0/24.",
  },
  IncorrectInstanceState: {
    meaning:
      "The instance is in the wrong state for this action, e.g. changing its type while it's running, or attaching an Elastic IP while it's still starting.",
    fix: "Check the instance's state; stop it (or wait for it to finish starting) and try again.",
  },
  "InvalidVpc.Range": {
    meaning: "The VPC's CIDR block is too big or too small. VPCs must be between /16 (65,536 addresses) and /28 (16).",
    fix: "Use a size between /16 and /28, e.g. 10.0.0.0/16.",
  },
  RouteAlreadyExists: {
    meaning: "The route table already has a route for that destination.",
    fix: "Edit or delete the existing route instead of adding another.",
  },
  MalformedXML: {
    meaning: "The request contained a value the service doesn't accept. For versioning, only Enabled or Suspended are valid once it has been turned on.",
    fix: "Use Suspended to stop versioning; it can't go back to Disabled.",
  },
  DryRunOperation: {
    meaning: "Not really an error: with --dry-run, AWS only checks whether you could run the command.",
    fix: "Remove --dry-run to actually run it.",
  },
  InvalidID: {
    meaning: "That doesn't look like any kind of resource ID.",
    fix: "IDs start with a prefix such as vpc-, subnet-, sg- or i-. Copy the ID from a describe command.",
  },
  IncorrectState: {
    meaning: "The resource is in the wrong state for this action, e.g. resizing a running server.",
    fix: "Check its current state, move it to the required one (often 'stopped'), then retry.",
  },
  BucketAlreadyExists: {
    meaning: "Another account already owns a bucket with that name. Bucket names are shared by everyone.",
    fix: "Add something unique, e.g. your initials and a date.",
  },
  BucketAlreadyOwnedByYou: {
    meaning: "You already created a bucket with this name.",
    fix: "Use the existing bucket or pick another name.",
  },
  InvalidBucketName: {
    meaning: "The name breaks a bucket naming rule (the service doesn't say which one).",
    fix: "Use 3–63 lowercase letters, numbers, dots or hyphens, starting and ending with a letter or number.",
  },
  "Resource.AlreadyAssociated": {
    meaning:
      "The resource is already connected to something, and can only be connected to one (a VPC has one internet gateway; a subnet uses one route table; an Elastic IP points at one instance).",
    fix: "Disconnect it from the current one first. For an Elastic IP, disassociate it, or pass --allow-reassociation.",
  },
  "InvalidGroup.Duplicate": {
    meaning: "A security group with that name already exists in this VPC.",
    fix: "Use a different group name.",
  },
  "InvalidPermission.Duplicate": {
    meaning: "That exact firewall rule already exists.",
    fix: "Nothing to do: the traffic is already allowed.",
  },
  "InvalidPermission.NotFound": {
    meaning: "You tried to remove a rule that doesn't exist.",
    fix: "Describe the security group to see its rules, then match one exactly.",
  },
  "Gateway.NotAttached": {
    meaning:
      "The VPC has no internet gateway attached (or not the one you named). Public addresses, including Elastic IPs, only work through one.",
    fix: "Attach an internet gateway to the VPC, or check which VPC it's on with describe-internet-gateways.",
  },
  "InvalidKeyPair.NotFound": {
    meaning: "No key pair with that name exists in this region. Key pairs belong to one region.",
    fix: "Create it first (create-key-pair), or check the name and the region selector.",
  },
  "InvalidKeyPair.Duplicate": {
    meaning: "You already have a key pair with that name in this region.",
    fix: "Use the existing one, or delete it first. The private key can't be downloaded again, so delete and recreate if you lost it.",
  },
  "InvalidIPAddress.InUse": {
    meaning: "The Elastic IP is still attached to an instance, so it can't be released.",
    fix: "Disassociate it first (disassociate-address), then release it.",
  },
  UnauthorizedOperation: {
    meaning: "The identity you're using (top right: Acting as) has no policy that allows this EC2 action, or a policy denies it.",
    fix: "Attach a policy that allows the action named in the message, or switch back to the root user. The user's Check permissions panel shows which policy decides.",
  },
  AccessDenied: {
    meaning: "The identity you're using isn't allowed to do this: no policy allows the action on that resource, or one explicitly denies it.",
    fix: "Read the action and resource in the message, then allow exactly that in a policy (or switch back to the root user).",
  },
  InvalidClientTokenId: {
    meaning: "The credentials belong to an IAM user that no longer exists.",
    fix: "Switch to another identity at the top right (Acting as).",
  },
  NoSuchEntity: {
    meaning: "The IAM user, group, role or policy you named doesn't exist. IAM names are case sensitive.",
    fix: "List them (aws iam list-users, list-groups, list-roles, list-policies) and check the spelling.",
  },
  EntityAlreadyExists: {
    meaning: "An IAM user, group, role or policy with that name already exists.",
    fix: "Use the existing one or pick another name.",
  },
  DeleteConflict: {
    meaning: "It's still attached to something. IAM won't delete users, groups, roles or policies that are in use.",
    fix: "Do what the message says first: detach policies, remove users from groups, delete access keys, or take the role off instances.",
  },
  MalformedPolicyDocument: {
    meaning: "The policy JSON isn't valid IAM policy grammar.",
    fix: 'Each statement needs "Effect" (Allow or Deny), "Action" (like "s3:GetObject") and "Resource" (an ARN or "*"). Identity policies have no "Principal".',
  },
  LimitExceeded: {
    meaning: "You've hit an IAM limit, e.g. 10 policies per user or 2 access keys per user.",
    fix: "Remove one first. Too many policies on one user usually means it's time for a group.",
  },
  NatGatewayNotFound: {
    meaning: "No NAT gateway with that ID exists in this region (or it has been deleted).",
    fix: "List them with describe-nat-gateways, and check the region selector.",
  },
  NatGatewayMalformed: {
    meaning: "That isn't a valid NAT gateway ID.",
    fix: "NAT gateway IDs look like nat-0a1b2c3d4e5f67890. Copy it rather than typing it.",
  },
  DBInstanceNotFound: {
    meaning: "No database with that identifier exists in this region.",
    fix: "List them with aws rds describe-db-instances. Identifiers are lowercase, and databases live in one region.",
  },
  DBInstanceAlreadyExists: {
    meaning: "A database with that identifier already exists in this region.",
    fix: "Pick another identifier, or use the existing database.",
  },
  InvalidDBInstanceState: {
    meaning: "The database is busy or in the wrong state for this: e.g. still creating, modifying or rebooting, or stopped when you tried to change it.",
    fix: "Wait until it's 'available' (or start it if it's stopped), then try again.",
  },
  DBSubnetGroupDoesNotCoverEnoughAZs: {
    meaning: "A DB subnet group needs subnets in at least two availability zones, so RDS can place a standby in a second zone.",
    fix: "Add a subnet from another zone (for a private database, another private subnet).",
  },
  DBSubnetGroupNotFoundFault: {
    meaning: "No DB subnet group with that name exists in this region.",
    fix: "Create one first (aws rds create-db-subnet-group), or check the name with describe-db-subnet-groups.",
  },
  DBSubnetGroupAlreadyExists: {
    meaning: "A DB subnet group with that name already exists.",
    fix: "Pick another name, or change the existing group's subnets with modify-db-subnet-group.",
  },
  InvalidDBSubnetGroupStateFault: {
    meaning: "A database still uses this DB subnet group, so it can't be deleted.",
    fix: "Delete (or move) the databases that use it first.",
  },
  InvalidVPCNetworkStateFault: {
    meaning: "The VPC can't support what you asked for. Usually: a publicly accessible database in a VPC with no internet gateway.",
    fix: "Keep the database private (recommended), or attach an internet gateway to the VPC.",
  },
  DBSnapshotAlreadyExists: {
    meaning: "A snapshot with that identifier already exists.",
    fix: "Pick another identifier, e.g. add the date: app-db-2026-05-01.",
  },
  DBSnapshotNotFound: {
    meaning: "No snapshot with that identifier exists in this region.",
    fix: "List them with aws rds describe-db-snapshots.",
  },
  InvalidDBSnapshotState: {
    meaning: "The snapshot isn't ready yet (still creating).",
    fix: "Wait until its status is 'available', then restore or delete it.",
  },
  InvalidParameterCombination: {
    meaning:
      "Two settings don't work together: e.g. a route with both an internet gateway and a NAT gateway, a database engine and a version that don't match, or deleting a database without saying what to do about the final snapshot.",
    fix: "Read the message: it names the conflict. For delete-db-instance, add --skip-final-snapshot or --final-db-snapshot-identifier <name>.",
  },
  AddressLimitExceeded: {
    meaning: "You've reached the limit of Elastic IPs in this region (5).",
    fix: "Release addresses you don't use. Unused Elastic IPs cost money in a real account, so it's a good habit anyway.",
  },
  VPCIdNotSpecified: {
    meaning: "There's no default VPC, so you have to say which VPC or subnet to use.",
    fix: "Pass --subnet-id (for instances) or --vpc-id (for security groups).",
  },
  InsufficientFreeAddressesInSubnet: {
    meaning: "The subnet has run out of IP addresses.",
    fix: "Launch into a bigger subnet, or terminate instances you don't need.",
  },
  IllegalVersioningConfigurationException: {
    meaning: "Versioning can't go back to Disabled once it has been enabled.",
    fix: "Suspend it instead.",
  },
  ResourceInUse: {
    meaning:
      "Something still depends on this. A target group used by a load balancer's listener can't be deleted, and an Auto Scaling group with instances can't be deleted without --force-delete.",
    fix: "Remove the listener (or delete the load balancer) first. For an Auto Scaling group, set desired capacity to 0 and wait, or delete it with --force-delete to terminate its instances too.",
  },
  DuplicateListener: {
    meaning: "The load balancer already has a listener on that port. Each port can have only one.",
    fix: "Use a different port, or change the existing listener instead of adding another.",
  },
  DuplicateTargetGroupName: {
    meaning: "Target group names are unique in a region, and that one is taken.",
    fix: "Pick another name, or use the existing target group.",
  },
  DuplicateLoadBalancerName: {
    meaning: "Load balancer names are unique in a region, and that one is taken.",
    fix: "Pick another name, or use the existing load balancer.",
  },
  InvalidTarget: {
    meaning: "The instance can't be a target here: it doesn't exist, is terminated, or is in a different VPC from the target group.",
    fix: "Register running instances from the target group's VPC. To use another VPC, create a target group there.",
  },
  InvalidSubnet: {
    meaning: "An internet-facing load balancer has to be reachable from the internet, so its VPC needs an internet gateway.",
    fix: "Attach an internet gateway to the VPC and put the load balancer in public subnets (0.0.0.0/0 → the gateway).",
  },
  InvalidConfigurationRequest: {
    meaning: "The load balancer's settings don't fit together, e.g. subnets from different VPCs, two subnets in one zone, or a target group from another VPC.",
    fix: "Use one subnet per zone, all in the same VPC as the target groups and security groups.",
  },
  InvalidSecurityGroup: {
    meaning: "A security group from a different VPC was given to the load balancer.",
    fix: "Choose security groups from the load balancer's own VPC.",
  },
  TargetGroupNotFound: {
    meaning: "No target group with that ARN (or name) exists in this region.",
    fix: "List them with aws elbv2 describe-target-groups and copy the TargetGroupArn exactly.",
  },
  LoadBalancerNotFound: {
    meaning: "No load balancer with that ARN (or name) exists in this region.",
    fix: "List them with aws elbv2 describe-load-balancers and copy the LoadBalancerArn exactly.",
  },
  ListenerNotFound: {
    meaning: "No listener with that ARN exists.",
    fix: "List the load balancer's listeners with aws elbv2 describe-listeners --load-balancer-arn <arn>.",
  },
  AlreadyExists: {
    meaning: "An Auto Scaling group with that name already exists in this region.",
    fix: "Pick another name, or change the existing group with update-auto-scaling-group.",
  },
  "InvalidLaunchTemplateName.AlreadyExistsException": {
    meaning: "Launch template names are unique in a region, and that one is taken.",
    fix: "Pick another name, or create a new version of the existing template.",
  },
  "InvalidLaunchTemplateName.NotFoundException": {
    meaning: "No launch template with that name exists in this region.",
    fix: "List them with aws ec2 describe-launch-templates.",
  },
  ResourceNotFoundException: {
    meaning: "That function, policy statement, log group or log stream doesn't exist in this region.",
    fix: "Check the name and region: aws lambda list-functions or aws logs describe-log-groups. Both live in one region. A function's log group appears after its first run.",
  },
  NetworkAclEntryAlreadyExists: {
    meaning: "That rule number is already used in this direction of the network ACL. Each rule number appears once per direction (inbound and outbound are separate).",
    fix: "Pick a free number (leave gaps, like 100, 110, 120, so you can insert rules later), or replace the existing rule with replace-network-acl-entry.",
  },
  "InvalidNetworkAclID.NotFound": {
    meaning: "No network ACL with that ID in this region. They look like acl-0a1b2c3d4e5f67890.",
    fix: "List them with aws ec2 describe-network-acls --filters Name=vpc-id,Values=<vpc-id>.",
  },
  VpcPeeringConnectionAlreadyExists: {
    meaning: "These two VPCs already have a peering connection (pending or active). Two VPCs can only be peered once.",
    fix: "Use the existing one: aws ec2 describe-vpc-peering-connections.",
  },
  "InvalidVpcPeeringConnectionID.NotFound": {
    meaning: "No peering connection with that ID in this region (or it was rejected or deleted).",
    fix: "List them with aws ec2 describe-vpc-peering-connections, and check the region.",
  },
  InvalidStateTransition: {
    meaning: "The peering connection isn't waiting for an answer: it's already active, rejected or being set up.",
    fix: "Check its status with describe-vpc-peering-connections. Only a pending-acceptance request can be accepted or rejected.",
  },
  InvalidServiceName: {
    meaning: "That isn't a VPC endpoint service in this region. Gateway endpoints exist for S3 and DynamoDB, named com.amazonaws.<region>.s3 and com.amazonaws.<region>.dynamodb.",
    fix: "Use the service name for the region you're in, e.g. com.amazonaws.us-east-1.s3.",
  },
  "InvalidVolume.ZoneMismatch": {
    meaning: "The volume and the instance are in different Availability Zones. A volume can only attach to instances in its own zone, and neither can move.",
    fix: "Snapshot the volume (or use an existing snapshot) and restore it as a new volume in the instance's zone, then attach that.",
  },
  VolumeInUse: {
    meaning: "The volume is attached to an instance, so it can't be deleted or attached somewhere else.",
    fix: "Detach it first (unmount it on the server, then detach-volume or clear Attached to instance), wait until it's available, then try again.",
  },
  "InvalidVolume.NotFound": {
    meaning: "No volume with that ID in this region. Volume IDs look like vol-0a1b2c3d4e5f67890.",
    fix: "Check the region at the top, and list them with aws ec2 describe-volumes.",
  },
  "InvalidSnapshot.NotFound": {
    meaning: "No snapshot with that ID in this region. Snapshots belong to one region: to use one elsewhere, copy it there first.",
    fix: "Check the region, or run aws ec2 copy-snapshot in the target region with --source-region.",
  },
  OperationNotPermitted: {
    meaning: "That action isn't allowed here, e.g. detaching an instance's root volume, which it needs to run.",
    fix: "Stop or terminate the instance instead, or work with its data volumes.",
  },
  InvalidChangeBatch: {
    meaning:
      "Route 53 refused a record change. Common reasons: a CNAME at the domain itself (the apex), a CNAME next to other records with the same name, a record that already exists, a value that isn't an IP address, or a name outside the zone.",
    fix: "Read the message in brackets: it names the record. At the apex, use an A record with Alias on instead of a CNAME. To change an existing record, edit it (UPSERT) rather than creating it again.",
  },
  NoSuchHostedZone: {
    meaning: "There's no hosted zone with that ID in your account. Zone IDs look like Z0123456789ABCDEFGHIJ (the /hostedzone/ prefix is optional).",
    fix: "List your zones with aws route53 list-hosted-zones and copy the ID.",
  },
  HostedZoneNotEmpty: {
    meaning: "A hosted zone can only be deleted once it holds nothing but its own NS and SOA records.",
    fix: "Delete your other records first (in the console, or with a DELETE change batch), then delete the zone.",
  },
  HostedZoneAlreadyExists: {
    meaning: "Another hosted zone was already created with this caller reference. It's a unique string that stops the same request creating two zones by accident.",
    fix: "Use a new value for --caller-reference, e.g. the date and time: --caller-reference $(date +%s).",
  },
  InvalidDomainName: {
    meaning: "That isn't a domain Route 53 can host: it has characters not allowed in DNS names, or it's reserved (like example.com, or a bare top-level domain such as com).",
    fix: "Use letters, digits and hyphens, with dots between parts, e.g. myshop.com.",
  },
  NoSuchHealthCheck: {
    meaning: "There's no health check with that ID. Health check IDs look like a UUID: 1a2b3c4d-….",
    fix: "List them with aws route53 list-health-checks.",
  },
  HealthCheckInUse: {
    meaning: "A record still uses this health check, so it can't be deleted.",
    fix: "Edit the record to remove the health check (or delete the record) first.",
  },
  InvalidInput: {
    meaning: "Route 53 rejected a value or a missing field: e.g. a weighted record without a Record ID (SetIdentifier), a record with both an alias and a TTL, or a health check aimed at a private IP.",
    fix: "Read the message: it names the field. Health checks run on the internet, so they need a public IP or a domain name.",
  },
  ResourceNotFound: {
    meaning: "CloudWatch can't find that alarm or dashboard. Alarms belong to one region; dashboards are global.",
    fix: "List them: aws cloudwatch describe-alarms or aws cloudwatch list-dashboards, and check the name's spelling and case.",
  },
  ResourceAlreadyExistsException: {
    meaning: "A log group or log stream with that name already exists.",
    fix: "Use the existing one, or pick another name. Lambda creates /aws/lambda/<function> for you on the first run.",
  },
  InvalidParameterException: {
    meaning: "CloudWatch Logs rejected a value, e.g. a retention period it doesn't offer (it must be 1, 3, 5, 7, 14, 30, 60, 90… days) or an invalid name.",
    fix: "Read the message for the allowed values. aws logs put-retention-policy --retention-in-days 7 is a good start.",
  },
  InvalidParameterInput: {
    meaning: "The dashboard body isn't valid: it must be JSON with a widgets list, and each metric widget needs properties.metrics.",
    fix: 'Start from {"widgets":[{"type":"metric","properties":{"metrics":[["AWS/Lambda","Invocations","FunctionName","hello"]],"stat":"Sum","period":60}}]}, or use "Add to dashboard" under any graph.',
  },
  ResourceConflictException: {
    meaning: "The function is busy or already exists: still Pending after creation, a name that's taken, or a statement ID already in its policy.",
    fix: "Wait a second and retry, or pick another name or statement ID.",
  },
  InvalidParameterValueException: {
    meaning:
      "Lambda rejected a setting. Common ones: a role whose trust policy doesn't allow lambda.amazonaws.com, a reserved environment variable like AWS_REGION, an old runtime, or a zip without code.",
    fix: "Read the message: it names the setting. For roles, add lambda.amazonaws.com as a trusted service.",
  },
  TooManyRequestsException: {
    meaning: "Too many invocations in a short time (CloudLab allows 60 a minute per account, like a small concurrency limit on AWS).",
    fix: "Wait a minute and try again.",
  },
  ValidationException: {
    meaning: "A value doesn't match the format AWS expects, e.g. a function name with spaces or a timeout over 900 seconds.",
    fix: "The message quotes the rule (often a regular expression); adjust the value to match it.",
  },
  InvalidRequestContentException: {
    meaning: "The payload isn't valid JSON.",
    fix: "Check quotes and commas. In the terminal, wrap the JSON in single quotes and add --cli-binary-format raw-in-base64-out.",
  },
  RequestTooLargeException: {
    meaning: "The event you sent is too big.",
    fix: "Send less data, or store it in S3 and pass its key instead.",
  },
  NotFoundException: {
    meaning: "API Gateway can't find that API, route, integration or stage. IDs are short codes like a1b2c3d4e5, specific to a region.",
    fix: "List them: aws apigatewayv2 get-apis, then get-routes / get-integrations / get-stages --api-id <id>.",
  },
  BadRequestException: {
    meaning: "API Gateway rejected the request: e.g. a route key that isn't 'METHOD /path' or $default, or an integration without a payload format version.",
    fix: "Read the message; route keys look like GET /hello or ANY /{proxy+}.",
  },
  ConflictException: {
    meaning: "Something with that key already exists, e.g. a second GET /hello route or a stage name that's taken.",
    fix: "Change the existing one instead, or use another key.",
  },
  ValidationError: {
    meaning: "One of the values you entered isn't valid.",
    fix: "Check the highlighted field's message.",
  },
  InvalidParameterValue: {
    meaning: "A value is valid on its own but doesn't fit this situation (e.g. resources in different VPCs).",
    fix: "Read the message: it names the conflicting resources.",
  },
  InvalidParameter: {
    meaning:
      "One value isn't accepted. The message says which: in SNS it reads 'Invalid parameter: <what>' (an email address, a topic name, a filter policy). In EC2 it often means two resources you chose don't belong together.",
    fix: "Fix the value the message names. For SNS ARNs, copy them from the topic's page; for EC2, make sure the resources are in the same VPC and region.",
  },
  NotFound: {
    meaning: "SNS couldn't find that topic or subscription in this region. A subscription waiting for confirmation has no ARN yet, so it can't be looked up either.",
    fix: "Copy the ARN from list-topics or list-subscriptions, and check the region in the ARN matches the one you're using.",
  },
  ParameterValueInvalid: {
    meaning: "A message attribute is incomplete or has the wrong type, e.g. a Number attribute whose value isn't a number.",
    fix: "Each attribute needs DataType (String, Number or String.Array) and a StringValue.",
  },
  "AWS.SimpleQueueService.NonExistentQueue": {
    meaning: "No queue with that URL (or name) exists in this region and account.",
    fix: "Get the exact URL with aws sqs get-queue-url --queue-name <name>, and check the region: the URL contains it.",
  },
  QueueAlreadyExists: {
    meaning: "A queue with this name exists with different settings. CreateQueue only returns the existing queue when every setting matches.",
    fix: "Use the existing queue (get-queue-url), change it with set-queue-attributes, or pick another name.",
  },
  ReceiptHandleIsInvalid: {
    meaning: "That isn't a receipt handle. Deleting a message needs the ReceiptHandle from receive-message, not the MessageId.",
    fix: "Receive the message and copy its ReceiptHandle (the long string), then delete with it.",
  },
  MessageNotInflight: {
    meaning: "The message isn't hidden any more: its visibility timeout already ran out (or it was deleted), so its visibility can't be changed.",
    fix: "Receive it again and use the new receipt handle. If this keeps happening, raise the queue's visibility timeout.",
  },
  InvalidAttributeValue: {
    meaning: "A queue setting is out of range, e.g. VisibilityTimeout above 43200 or MessageRetentionPeriod below 60.",
    fix: "Check the allowed range in the message, or the field's description in the console.",
  },
  InvalidAttributeName: {
    meaning: "SQS doesn't know that attribute name, or it's read-only (like QueueArn or ApproximateNumberOfMessages).",
    fix: "Attribute names are case-sensitive: VisibilityTimeout, DelaySeconds, RedrivePolicy, Policy…",
  },
  "AWS.SimpleQueueService.PurgeQueueInProgress": {
    meaning: "A queue can be purged only once every 60 seconds.",
    fix: "Wait a minute. The previous purge already removed what was there.",
  },
  OverLimit: {
    meaning: "The queue has reached a limit (in CloudLab: 1,000 messages or 4 MB).",
    fix: "Receive and delete messages, or purge the queue.",
  },
  SubscriptionLimitExceeded: {
    meaning: "The topic has as many subscriptions as it's allowed.",
    fix: "Remove subscriptions you no longer use (CloudLab allows 100 per topic).",
  },
  MissingParameter: {
    meaning: "A required option is missing.",
    fix: "Add the option named in the message.",
  },
};

export function explainError(code: string): ErrorExplanation | undefined {
  if (EXPLANATIONS[code]) return EXPLANATIONS[code];
  if (code.endsWith(".Malformed")) {
    return {
      meaning: "The ID isn't in the right format, so the service couldn't even look it up.",
      fix: "Real IDs are a prefix plus hex digits, e.g. vpc-0a1b2c3d4e5f67890. Copy it rather than typing it.",
    };
  }
  if (code.endsWith(".NotFound") || code === "NoSuchBucket" || code === "ResourceNotFound") {
    return {
      meaning: "The ID you used doesn't exist in this account and region.",
      fix: "Check for typos, and make sure the region selector matches where you created it.",
    };
  }
  return undefined;
}
