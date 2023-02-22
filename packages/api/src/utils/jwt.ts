import { User } from "@tix/db";
import { sign, verify } from "jsonwebtoken";

const JWT_SECRET = process.env.NEXTAUTH_SECRET ?? "secret";

interface TokenPayload {
  id: User["id"];
  username: User["username"];
}

export class JWT {
  static sign(arg: TokenPayload) {
    return sign(arg, JWT_SECRET);
  }

  static verify(token: string) {
    return verify(token, JWT_SECRET) as TokenPayload;
  }
}
