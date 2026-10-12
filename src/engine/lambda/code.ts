import { strToU8, unzipSync, zipSync } from "fflate";
import { EngineError } from "../errors";
import { MAX_CODE_BYTES, MAX_FILES } from "../fields";

/**
 * Function code arrives as a .zip, as with real Lambda. Nuvora keeps the text
 * files (source, JSON); folders inside the zip stay as path prefixes, so a zip
 * of a folder (myfn/index.mjs) fails to find "index" just like on AWS.
 */
export function filesFromZip(data: Buffer): Record<string, string> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(data));
  } catch {
    throw new EngineError("InvalidParameterValueException", "Could not unzip uploaded file. Please check your file, then try to upload again.");
  }
  const files: Record<string, string> = {};
  let total = 0;
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith("/") || path.startsWith("__MACOSX/") || path.endsWith(".DS_Store")) continue;
    total += bytes.length;
    if (total > MAX_CODE_BYTES) {
      throw new EngineError(
        "InvalidParameterValueException",
        `Unzipped size must be smaller than ${MAX_CODE_BYTES} bytes in Nuvora (no node_modules: Nuvora functions can't use packages yet).`,
      );
    }
    const text = Buffer.from(bytes).toString("utf8");
    // Binary files (images, native modules) can't run here; skip them rather than corrupting them.
    if (text.includes("�")) continue;
    files[path] = text;
  }
  if (Object.keys(files).length === 0) throw new EngineError("InvalidParameterValueException", "Uploaded file must be a non-empty zip");
  if (Object.keys(files).length > MAX_FILES) throw new EngineError("InvalidParameterValueException", `Nuvora allows at most ${MAX_FILES} files per function.`);
  return files;
}

/** The function's code as a .zip (for downloads). */
export function zipFromFiles(files: Record<string, string>): Buffer {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
}
