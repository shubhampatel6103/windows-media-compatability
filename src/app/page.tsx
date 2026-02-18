"use client";

import { useMemo, useRef, useState } from "react";

type Heic2Any = typeof import("heic2any").default;
type FfmpegInstance = import("@ffmpeg/ffmpeg").FFmpeg;
type FetchFile = typeof import("@ffmpeg/util").fetchFile;
type ToBlobURL = typeof import("@ffmpeg/util").toBlobURL;

type ProcessItem = {
  fileHandle: FileSystemFileHandle;
  parentDirectory?: FileSystemDirectoryHandle;
  relativePath: string;
};

const IPHONE_IMAGE_EXTENSIONS = new Set(["heic", "heif", "heics", "avif"]);
const IPHONE_VIDEO_EXTENSIONS = new Set(["mov", "qt", "m4v"]);

const FF_CORE_VERSION = "0.12.10";

function getExtension(fileName: string) {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot < 0) {
    return "";
  }

  return fileName.slice(lastDot + 1).toLowerCase();
}

function replaceExtension(fileName: string, extension: string) {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot < 0) {
    return `${fileName}.${extension}`;
  }

  return `${fileName.slice(0, lastDot)}.${extension}`;
}

async function ensureReadWritePermission(handle: FileSystemHandle) {
  const currentPermission = await handle.queryPermission({ mode: "readwrite" });
  if (currentPermission === "granted") {
    return true;
  }

  const requestedPermission = await handle.requestPermission({
    mode: "readwrite",
  });
  return requestedPermission === "granted";
}

async function collectProcessItemsFromDirectory(
  directory: FileSystemDirectoryHandle,
  basePath = "",
): Promise<ProcessItem[]> {
  const items: ProcessItem[] = [];

  for await (const [entryName, handle] of directory.entries()) {
    const nextPath = basePath ? `${basePath}/${entryName}` : entryName;

    if (handle.kind === "file") {
      const fileHandle = handle as FileSystemFileHandle;
      items.push({
        fileHandle,
        parentDirectory: directory,
        relativePath: nextPath,
      });
      continue;
    }

    const subDirectoryHandle = handle as FileSystemDirectoryHandle;
    const nestedItems = await collectProcessItemsFromDirectory(
      subDirectoryHandle,
      nextPath,
    );
    items.push(...nestedItems);
  }

  return items;
}

export default function Home() {
  const [items, setItems] = useState<ProcessItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [summary, setSummary] = useState("No folder selected.");
  const [convertedProgressCount, setConvertedProgressCount] = useState(0);
  const [progressTargetCount, setProgressTargetCount] = useState(0);
  const ffmpegRef = useRef<FfmpegInstance | null>(null);
  const heic2AnyRef = useRef<Heic2Any | null>(null);
  const ffmpegUtilRef = useRef<{
    fetchFile: FetchFile;
    toBlobURL: ToBlobURL;
  } | null>(null);
  const ffmpegLoadedRef = useRef(false);

  const supportedCount = useMemo(
    () =>
      items.filter((entry) => {
        const extension = getExtension(entry.fileHandle.name);
        return (
          IPHONE_IMAGE_EXTENSIONS.has(extension) ||
          IPHONE_VIDEO_EXTENSIONS.has(extension)
        );
      }).length,
    [items],
  );

  const progressPercent =
    progressTargetCount > 0
      ? Math.round((convertedProgressCount / progressTargetCount) * 100)
      : 0;

  const loadHeic2Any = async () => {
    if (heic2AnyRef.current) {
      return heic2AnyRef.current;
    }

    const heicModule = await import("heic2any");
    heic2AnyRef.current = heicModule.default;
    return heicModule.default;
  };

  const loadFfmpeg = async () => {
    if (!ffmpegRef.current) {
      const ffmpegModule = await import("@ffmpeg/ffmpeg");
      ffmpegRef.current = new ffmpegModule.FFmpeg();
    }

    if (!ffmpegUtilRef.current) {
      const ffmpegUtilModule = await import("@ffmpeg/util");
      ffmpegUtilRef.current = {
        fetchFile: ffmpegUtilModule.fetchFile,
        toBlobURL: ffmpegUtilModule.toBlobURL,
      };
    }

    if (ffmpegLoadedRef.current) {
      return ffmpegRef.current;
    }

    const ffmpeg = ffmpegRef.current;
    const util = ffmpegUtilRef.current;
    const coreURL = await util.toBlobURL(
      `https://unpkg.com/@ffmpeg/core@${FF_CORE_VERSION}/dist/umd/ffmpeg-core.js`,
      "text/javascript",
    );
    const wasmURL = await util.toBlobURL(
      `https://unpkg.com/@ffmpeg/core@${FF_CORE_VERSION}/dist/umd/ffmpeg-core.wasm`,
      "application/wasm",
    );

    await ffmpeg.load({ coreURL, wasmURL });
    ffmpegLoadedRef.current = true;
    return ffmpeg;
  };

  const convertHeicToJpeg = async (blob: Blob) => {
    const heic2any = await loadHeic2Any();
    const converted = await heic2any({
      blob,
      toType: "image/jpeg",
      quality: 0.9,
    });

    if (Array.isArray(converted)) {
      return converted[0];
    }

    return converted;
  };

  const convertMovToMp4 = async (blob: Blob) => {
    const ffmpeg = await loadFfmpeg();
    const util = ffmpegUtilRef.current;
    if (!util) {
      throw new Error("FFmpeg utilities failed to load.");
    }
    const inputName = `input-${crypto.randomUUID()}.mov`;
    const outputName = `output-${crypto.randomUUID()}.mp4`;

    await ffmpeg.writeFile(inputName, await util.fetchFile(blob));
    await ffmpeg.exec(["-i", inputName, "-movflags", "faststart", outputName]);
    const outputData = await ffmpeg.readFile(outputName);

    await ffmpeg.deleteFile(inputName);
    await ffmpeg.deleteFile(outputName);

    const bytes =
      typeof outputData === "string"
        ? new TextEncoder().encode(outputData)
        : outputData;
    const normalizedBytes = new Uint8Array(bytes.byteLength);
    normalizedBytes.set(bytes);

    return new Blob([normalizedBytes.buffer], { type: "video/mp4" });
  };

  const writeBlobToFile = async (
    parentDirectory: FileSystemDirectoryHandle,
    outputName: string,
    blob: Blob,
  ) => {
    const destination = await parentDirectory.getFileHandle(outputName, {
      create: true,
    });
    const writable = await destination.createWritable();
    await writable.write(blob);
    await writable.close();
  };

  const overwriteBlobInSourceFile = async (
    fileHandle: FileSystemFileHandle,
    blob: Blob,
  ) => {
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  };

  const processItems = async () => {
    if (items.length === 0 || isProcessing) {
      return;
    }

    const totalConvertible = items.filter((item) => {
      const extension = getExtension(item.fileHandle.name);
      return (
        IPHONE_IMAGE_EXTENSIONS.has(extension) ||
        IPHONE_VIDEO_EXTENSIONS.has(extension)
      );
    }).length;

    setIsProcessing(true);
    setSummary("Converting files...");
    setConvertedProgressCount(0);
    setProgressTargetCount(totalConvertible);

    let convertedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const item of items) {
      const extension = getExtension(item.fileHandle.name);
      const isConvertibleImage = IPHONE_IMAGE_EXTENSIONS.has(extension);
      const isConvertibleVideo = IPHONE_VIDEO_EXTENSIONS.has(extension);

      if (!isConvertibleImage && !isConvertibleVideo) {
        skippedCount += 1;
        continue;
      }

      const permissionHandle = item.parentDirectory ?? item.fileHandle;
      const hasWritePermission =
        await ensureReadWritePermission(permissionHandle);
      if (!hasWritePermission) {
        failedCount += 1;
        continue;
      }

      try {
        const sourceFile = await item.fileHandle.getFile();

        if (isConvertibleImage) {
          const outputBlob = await convertHeicToJpeg(sourceFile);
          const outputName = replaceExtension(item.fileHandle.name, "jpg");
          if (item.parentDirectory) {
            await writeBlobToFile(item.parentDirectory, outputName, outputBlob);

            if (outputName !== item.fileHandle.name) {
              await item.parentDirectory.removeEntry(item.fileHandle.name);
            }
          } else {
            await overwriteBlobInSourceFile(item.fileHandle, outputBlob);
          }

          convertedCount += 1;
          setConvertedProgressCount(convertedCount);
          continue;
        }

        const outputBlob = await convertMovToMp4(sourceFile);
        const outputName = replaceExtension(item.fileHandle.name, "mp4");
        if (item.parentDirectory) {
          await writeBlobToFile(item.parentDirectory, outputName, outputBlob);

          if (outputName !== item.fileHandle.name) {
            await item.parentDirectory.removeEntry(item.fileHandle.name);
          }
        } else {
          await overwriteBlobInSourceFile(item.fileHandle, outputBlob);
        }

        convertedCount += 1;
        setConvertedProgressCount(convertedCount);
      } catch (error) {
        failedCount += 1;
      }
    }

    setSummary(
      `Done. Converted ${convertedCount}, skipped ${skippedCount}, failed ${failedCount}.`,
    );
    setIsProcessing(false);
  };

  const selectFolder = async () => {
    if (typeof window.showDirectoryPicker !== "function") {
      setSummary("Your browser does not support writable folder access.");
      return;
    }

    try {
      const directoryHandle = await window.showDirectoryPicker();
      const hasWritePermission =
        await ensureReadWritePermission(directoryHandle);
      if (!hasWritePermission) {
        setSummary("Folder access denied.");
        return;
      }

      const collectedItems =
        await collectProcessItemsFromDirectory(directoryHandle);
      setItems(collectedItems);
      setConvertedProgressCount(0);
      setProgressTargetCount(0);
      setSummary(`Loaded ${collectedItems.length} files from selected folder.`);
    } catch {
      setSummary("Folder selection cancelled.");
    }
  };

  const selectFiles = async () => {
    if (typeof window.showOpenFilePicker !== "function") {
      setSummary("Your browser does not support writable file access.");
      return;
    }

    try {
      const fileHandles = await window.showOpenFilePicker({ multiple: true });
      const nextItems: ProcessItem[] = fileHandles.map((fileHandle) => ({
        fileHandle,
        relativePath: fileHandle.name,
      }));

      setItems(nextItems);
      setConvertedProgressCount(0);
      setProgressTargetCount(0);
      setSummary(`Loaded ${nextItems.length} file(s).`);
    } catch {
      setSummary("File selection cancelled.");
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();

    if (isProcessing) {
      return;
    }

    setIsDragging(false);

    const supportsHandleDrop =
      "getAsFileSystemHandle" in DataTransferItem.prototype;
    if (!supportsHandleDrop) {
      setSummary(
        "Drag-and-drop folder overwrite needs Chromium with File System Access API.",
      );
      return;
    }

    const nextItems: ProcessItem[] = [];

    for (const droppedItem of Array.from(event.dataTransfer.items)) {
      if (droppedItem.kind !== "file") {
        continue;
      }

      const handle = await droppedItem.getAsFileSystemHandle?.();
      if (!handle) {
        continue;
      }

      if (handle.kind === "directory") {
        const directoryHandle = handle as FileSystemDirectoryHandle;
        const nestedItems = await collectProcessItemsFromDirectory(
          directoryHandle,
          directoryHandle.name,
        );
        nextItems.push(...nestedItems);
        continue;
      }

      const fileHandle = handle as FileSystemFileHandle;
      nextItems.push({
        fileHandle,
        relativePath: fileHandle.name,
      });
    }

    if (nextItems.length === 0) {
      setSummary(
        "No writable folders found in drop. Use Select Folder for in-place replacement.",
      );
      return;
    }

    setItems(nextItems);
    setConvertedProgressCount(0);
    setProgressTargetCount(0);
    setSummary(`Loaded ${nextItems.length} files from dropped folders.`);
  };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold">
        iPhone Media to Windows Converter
      </h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Drop folders/files or select a folder/files. Folder mode scans
        subfolders, converts HEIC/HEIF/AVIF images to JPG and MOV/M4V/QT videos
        to MP4, then replaces originals in place.
      </p>

      <div
        onDragOver={(event) => {
          if (isProcessing) {
            return;
          }
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => {
          if (isProcessing) {
            return;
          }
          setIsDragging(false);
        }}
        onDrop={handleDrop}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition ${
          isDragging
            ? "border-foreground"
            : "border-zinc-300 dark:border-zinc-700"
        } ${isProcessing ? "pointer-events-none opacity-60" : ""}`}
        aria-disabled={isProcessing}
      >
        <p className="text-sm">
          Drop folders or files here for in-place conversion
        </p>
        <div className="mt-4 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={selectFolder}
            className="rounded-md bg-foreground px-4 py-2 text-sm text-background"
            disabled={isProcessing}
          >
            Select Folder
          </button>
          <button
            type="button"
            onClick={selectFiles}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
            disabled={isProcessing}
          >
            Select File(s)
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <p className="text-sm">Total files: {items.length}</p>
        <p className="text-sm">Convertible iPhone files: {supportedCount}</p>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {summary}
        </p>
        <button
          type="button"
          onClick={processItems}
          disabled={isProcessing || supportedCount === 0}
          className="mt-4 rounded-md border border-zinc-300 px-4 py-2 text-sm disabled:opacity-50 dark:border-zinc-700"
        >
          {isProcessing ? "Converting..." : "Convert and Replace In Place"}
        </button>
      </div>

      <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-sm font-medium">Progress</h2>
        <p className="mt-3 text-sm">
          {convertedProgressCount} / {progressTargetCount || supportedCount}{" "}
          converted
        </p>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {progressPercent}%
        </p>
      </div>
    </div>
  );
}
