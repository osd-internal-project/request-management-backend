/** ขอบเขตการข้ามรหัสที่ถูกใช้ไปแล้วโดยบริษัทอื่น. */
export const MAX_TAKEN_SKIPS = 1000;

/**
 * ดึงเลขจาก `next` จนได้รหัสที่ `isTaken` บอกว่ายังว่าง.
 * ช่องว่างยอมรับได้ รหัสซ้ำไม่ได้ — docs/run-number.md.
 */
export async function firstFreeCode(
  counter: string,
  next: () => Promise<string>,
  isTaken: (code: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_TAKEN_SKIPS; attempt++) {
    const code = await next();
    if (!(await isTaken(code))) return code;
  }

  throw new Error(
    `${counter} is behind by more than ${MAX_TAKEN_SKIPS} taken codes`,
  );
}
