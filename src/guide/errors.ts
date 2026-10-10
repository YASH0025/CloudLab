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
  InvalidParameterCombination: {
    meaning: "You gave two options that can't be used together, e.g. a route with both an internet gateway and a NAT gateway.",
    fix: "Keep one of them.",
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
