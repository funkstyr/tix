import { openApiDocument } from "@tix/api";
import { NextApiRequest, NextApiResponse } from "next";

// TODO: figure out if we can display via swagger-ui

// Respond with our OpenAPI schema
const handler = (req: NextApiRequest, res: NextApiResponse) => {
  res.status(200).send(openApiDocument);
};

export default handler;
