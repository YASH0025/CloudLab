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
  ValidationError: {
    meaning: "One of the values you entered isn't valid.",
    fix: "Check the highlighted field's message.",
  },
  InvalidParameterValue: {
    meaning: "A value is valid on its own but doesn't fit this situation (e.g. resources in different VPCs).",
    fix: "Read the message: it names the conflicting resources.",
  },
  InvalidParameter: {
    meaning: "Two of the resources you chose don't belong together.",
    fix: "Make sure they're in the same VPC and region.",
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
