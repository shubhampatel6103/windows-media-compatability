## Windows Media Compatibility Converter

Browser-based Next.js app that converts iPhone media formats to Windows-friendly formats and replaces files in place inside the selected folder.

- `HEIC/HEIF/HEICS/AVIF` → `JPG`
- `MOV/M4V/QT` → `MP4`

The app writes converted files into the same folder and removes the original source file.

## Requirements

- Chromium-based browser (Chrome / Edge) for File System Access API.
- Local folder access permission (`readwrite`) when prompted.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with a Chromium browser.

Use either:

- **Select Folder** to pick a writable folder.
- **Drag and drop folders** into the drop zone (Chromium only).

Then click **Convert and Replace In Place**.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
