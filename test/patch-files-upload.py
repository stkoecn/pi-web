import io

p = "app/api/files/[[...path]]/route.ts"
s = io.open(p, encoding="utf-8").read()

# 1. Device branch for POST: upload-check + upload.
old = '''    const uploadDirectory = await getUploadDirectory(segments);
    if ("response" in uploadDirectory) return uploadDirectory.response;
    const { directory } = uploadDirectory;
'''
new = '''    // A device directory is not on this filesystem, so the local allow-list
    // below refuses it outright. The device's own paths are its namespace.
    const postDeviceId = request.nextUrl.searchParams.get("deviceId") || request.headers.get("x-device-id");
    if (postDeviceId && postDeviceId !== "localhost") {
      return await handleRemoteUpload(request, postDeviceId, filePathFromApiSegments(segments), type);
    }

    const uploadDirectory = await getUploadDirectory(segments);
    if ("response" in uploadDirectory) return uploadDirectory.response;
    const { directory } = uploadDirectory;
'''
assert old in s, "POST uploadDirectory anchor not found"
s = s.replace(old, new, 1)

# 2. The remote upload handler, placed before POST.
anchor = '''export async function POST(
  request: NextRequest,'''
handler = '''/**
 * Device branch of uploads.
 *
 * Same request/response contract as the local branch (an `upload-check` that
 * reports conflicts, then a multipart `upload` that writes each file), so the
 * explorer's conflict dialog works unchanged against a device. Writes go over
 * SFTP; the conflict probe is one shell round trip.
 */
async function handleRemoteUpload(
  request: NextRequest,
  deviceId: string,
  directory: string,
  type: string,
): Promise<Response> {
  try {
    const { getGateway } = await import("@/lib/gateway/singleton");
    const driver = await getGateway().getOrConnectDriver(deviceId);

    if (type === "upload-check") {
      const body = await request.json().catch(() => null) as { fileNames?: unknown } | null;
      const fileNames = parseUploadFileNames(body?.fileNames);
      if (!fileNames) {
        return NextResponse.json({ error: "fileNames must be an array of strings" }, { status: 400 });
      }
      const validationError = validateUploadFileNames(fileNames);
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 });
      }
      return NextResponse.json(await inspectRemoteUploadTargets(driver, directory, fileNames));
    }

    if (type !== "upload") {
      return NextResponse.json({ error: "Invalid upload request type" }, { status: 400 });
    }

    const strategy = parseUploadConflictStrategy(request.nextUrl.searchParams.get("conflict"));
    if (!strategy) {
      return NextResponse.json({ error: "Invalid conflict strategy" }, { status: 400 });
    }

    let formData: FormData;
    try {
      formData = await parseFormDataWithinLimit(request, MAX_UPLOAD_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
      }
      throw error;
    }
    const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (files.some((file) => file.size > MAX_UPLOAD_FILE_BYTES)) {
      return NextResponse.json({ error: "Each upload must be 25MB or smaller" }, { status: 413 });
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
      return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
    }
    const fileNames = files.map((file) => file.name);
    const validationError = validateUploadFileNames(fileNames);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const inspection = await inspectRemoteUploadTargets(driver, directory, fileNames);
    if (strategy === "error" && inspection.conflicts.length > 0) {
      return NextResponse.json({
        error: "One or more files already exist",
        conflicts: inspection.conflicts,
        nonReplaceable: inspection.nonReplaceable,
      }, { status: 409 });
    }

    const conflictSet = new Set(inspection.conflicts);
    const nonReplaceableSet = new Set(inspection.nonReplaceable);
    const uploaded: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const file of files) {
      if (conflictSet.has(file.name) && strategy === "skip") {
        skipped.push(file.name);
        continue;
      }
      if (conflictSet.has(file.name) && nonReplaceableSet.has(file.name)) {
        errors.push({ name: file.name, error: "Cannot replace a directory or symbolic link" });
        continue;
      }
      try {
        const bytes = Buffer.from(await file.arrayBuffer());
        await driver.writeFile(joinRemotePath(directory, file.name), bytes);
        uploaded.push(file.name);
      } catch (error) {
        errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return NextResponse.json(
      { uploaded, skipped, errors },
      { status: errors.length > 0 ? 207 : 200 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

'''

assert anchor in s, "POST anchor not found"
s = s.replace(anchor, handler + anchor, 1)

# 3. Device branch for PUT (save an edited file).
old_put = '''    const content = await request.text();

    if (deviceId && deviceId !== "localhost") {
      const { getGateway } = await import("@/lib/gateway/singleton");
      const driver = await getGateway().getOrConnectDriver(deviceId);
      await driver.writeFile(filePath, content);
      return NextResponse.json({ success: true, size: Buffer.byteLength(content) });
    }
'''
new_put = '''    const content = await request.text();

    if (deviceId && deviceId !== "localhost") {
      // A remote save must not silently create the file in a local directory.
      const { getGateway } = await import("@/lib/gateway/singleton");
      const driver = await getGateway().getOrConnectDriver(deviceId);
      const parent = filePath.slice(0, filePath.lastIndexOf("/")) || "/";
      const exists = await statRemotePath(driver, parent);
      if (!exists || !exists.isDirectory) {
        return NextResponse.json({ error: "Directory does not exist" }, { status: 400 });
      }
      await driver.writeFile(filePath, content);
      return NextResponse.json({ success: true, size: Buffer.byteLength(content) });
    }
'''
assert old_put in s, "PUT remote block not found"
s = s.replace(old_put, new_put, 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("upload + PUT handled")
