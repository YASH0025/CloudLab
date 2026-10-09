import type { FieldOption, OptionsSource } from "./types";

/** Static catalog data the services draw on. Names are generic lab equivalents. */

export interface Region {
  code: string;
  name: string;
}

export const REGIONS: Region[] = [
  { code: "us-east-1", name: "US East (N. Virginia)" },
  { code: "us-west-2", name: "US West (Oregon)" },
  { code: "eu-west-1", name: "Europe (Ireland)" },
  { code: "ap-south-1", name: "Asia Pacific (Mumbai)" },
];

export const DEFAULT_REGION = "us-east-1";

export function isRegion(code: string): boolean {
  return REGIONS.some((r) => r.code === code);
}

export function availabilityZones(region: string): string[] {
  return ["a", "b", "c"].map((suffix) => `${region}${suffix}`);
}

export interface MachineImage {
  id: string;
  name: string;
  platform: "linux" | "windows";
  defaultUser: string;
}

export const IMAGES: MachineImage[] = [
  { id: "ami-0lab2023linux0001", name: "Lab Linux 2023", platform: "linux", defaultUser: "ec2-user" },
  { id: "ami-0ubuntu24040lts01", name: "Ubuntu Server 24.04 LTS", platform: "linux", defaultUser: "ubuntu" },
  { id: "ami-0debian120000001", name: "Debian 12", platform: "linux", defaultUser: "admin" },
  { id: "ami-0winsrv20220base1", name: "Windows Server 2022 Base", platform: "windows", defaultUser: "Administrator" },
];

export interface InstanceType {
  name: string;
  vcpus: number;
  memoryGiB: number;
  family: string;
}

export const INSTANCE_TYPES: InstanceType[] = [
  { name: "t3.nano", vcpus: 2, memoryGiB: 0.5, family: "General purpose (burstable)" },
  { name: "t3.micro", vcpus: 2, memoryGiB: 1, family: "General purpose (burstable)" },
  { name: "t3.small", vcpus: 2, memoryGiB: 2, family: "General purpose (burstable)" },
  { name: "t3.medium", vcpus: 2, memoryGiB: 4, family: "General purpose (burstable)" },
  { name: "m5.large", vcpus: 2, memoryGiB: 8, family: "General purpose" },
  { name: "c5.large", vcpus: 2, memoryGiB: 4, family: "Compute optimized" },
  { name: "r5.large", vcpus: 2, memoryGiB: 16, family: "Memory optimized" },
];

export function resolveOptions(source: OptionsSource, region: string): FieldOption[] {
  switch (source) {
    case "availabilityZones":
      return availabilityZones(region).map((az) => ({ value: az, label: az }));
    case "images":
      return IMAGES.map((img) => ({ value: img.id, label: img.name, hint: img.id }));
    case "instanceTypes":
      return INSTANCE_TYPES.map((t) => ({
        value: t.name,
        label: t.name,
        hint: `${t.vcpus} vCPU · ${t.memoryGiB} GiB · ${t.family}`,
      }));
  }
}
