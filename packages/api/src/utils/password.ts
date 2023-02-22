import { compare, hash } from "bcrypt";

const SALT_ROUNDS = 15;

export class Password {
  static async toHash(password: string): Promise<string> {
    const hashedPassword: string = await hash(password, SALT_ROUNDS);

    return hashedPassword;
  }

  static async compare(
    storedPassword: string,
    suppliedPassword: string,
  ): Promise<boolean> {
    const result: boolean = await compare(suppliedPassword, storedPassword);

    return result;
  }
}
