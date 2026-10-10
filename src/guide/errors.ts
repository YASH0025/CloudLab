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
    meaning: "The instance is in the wrong state for this action, e.g. changing its type while it's running.",
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
    meaning: "The resource is already connected to something, and can only be connected to one (a VPC has one internet gateway; a subnet uses one route table).",
    fix: "Disconnect it from the current one first.",
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
    meaning: "The internet gateway isn't attached to that VPC.",
    fix: "Check which VPC it's attached to with describe-internet-gateways.",
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
