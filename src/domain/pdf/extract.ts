import { extractText, getDocumentProxy } from "unpdf";
import { PdfPasswordError } from "../canonical";

const isPasswordFailure = (e: unknown): boolean => {
  const msg = String(e);
  return /PasswordException|password/i.test(msg);
};

export const toPdfPasswordError = (e: unknown): PdfPasswordError | null => {
  if (!isPasswordFailure(e)) return null;
  const msg = String(e);
  if (/No password given/i.test(msg)) {
    return new PdfPasswordError({ reason: "required" });
  }
  return new PdfPasswordError({ reason: "incorrect" });
};

export async function extractPdfText(
  file: Uint8Array,
  options: { password?: string; mergePages: boolean },
): Promise<{ text: string | string[]; totalPages: number }> {
  try {
    const pdf = await getDocumentProxy(
      file,
      options.password ? { password: options.password } : {},
    );
    if (options.mergePages) {
      return extractText(pdf, { mergePages: true });
    }
    return extractText(pdf, { mergePages: false });
  } catch (e) {
    if (e instanceof PdfPasswordError) throw e;
    const passwordErr = toPdfPasswordError(e);
    if (passwordErr) throw passwordErr;
    throw e;
  }
}
