import { put } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { writeFile } from 'fs/promises';
import { NextRequest} from 'next/server';
import path from 'path';

import { auth } from '@/app/(auth)/auth';

// Use Blob instead of File since File is not available in Node.js environment
const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= 5 * 1024 * 1024, {
      message: 'File size should be less than 5MB',
    })
    // Update the file type based on the kind of files you want to accept
    .refine((file) => ['image/jpeg', 'image/png'].includes(file.type), {
      message: 'File type should be JPEG or PNG',
    }),
});

export async function POST(request: NextRequest) {
  const data = await request.formData();
  const file: File | null = data.get('file') as unknown as File;

  if (!file) {
      return NextResponse.json({ success: false, error: "No file uploaded" });
  }

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  // Define a path to save the file, e.g., in the public directory
  const uploadDir = path.join(process.cwd(), '/public/uploads');
  const filePath = path.join(uploadDir, file.name);

  // Ensure the upload directory exists
  try {
      await require('fs').promises.mkdir(uploadDir, { recursive: true });
  } catch (e: any) {
      if (e.code !== 'EEXIST') {
          console.error("Error creating directory", e);
          return NextResponse.json({ success: false, error: "Error creating directory" });
      }
  }

  try {
      await writeFile(filePath, buffer);
      console.log(`File saved to ${filePath}`);
      // Return a public URL to the file
      const publicUrl = `/uploads/${file.name}`;
      return NextResponse.json({ success: true, url: publicUrl, name: file.name, contentType: file.type });
  } catch (e) {
      console.error("Error writing file", e);
      return NextResponse.json({ success: false, error: "Error writing file" });
  }
}
