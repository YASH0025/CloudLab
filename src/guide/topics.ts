/** Which skill each tutorial and challenge trains, for the progress page. */
export const TOPICS = ["Networking", "Compute", "Storage", "Databases", "Security", "Serverless", "Monitoring", "Messaging", "DNS", "Infrastructure as code"] as const;
export type Topic = (typeof TOPICS)[number];

export const TOPIC_OF: Record<string, Topic> = {
  // tutorials
  "first-network": "Networking",
  "first-web-server": "Compute",
  "troubleshoot-reachability": "Networking",
  "static-website": "Storage",
  "private-network": "Networking",
  "bastion-host": "Networking",
  "web-and-database": "Databases",
  "least-privilege": "Security",
  "serverless-api": "Serverless",
  "watch-your-app": "Monitoring",
  "get-alerted": "Messaging",
  "decouple-with-a-queue": "Messaging",
  "nosql-table": "Databases",
  "infrastructure-as-code": "Infrastructure as code",
  "managed-database": "Databases",
  "website-real-name": "DNS",
  "disks-and-backups": "Storage",
  "highly-available-website": "Compute",
  "connect-and-protect": "Networking",
  "stacks-that-share": "Infrastructure as code",
  "dns-failover": "DNS",
  "on-call-serverless": "Serverless",
  // challenges
  "site-down": "Networking",
  "no-updates": "Networking",
  "access-denied": "Security",
  "db-connect": "Databases",
  "api-500": "Serverless",
  "disk-wrong-zone": "Storage",
  "peering-one-way": "Networking",
  "acl-replies": "Networking",
  "unhealthy-targets": "Compute",
  "silent-orders": "Messaging",
  "double-charged": "Messaging",
  "orders-by-customer": "Databases",
  "stack-rolled-back": "Infrastructure as code",
};
