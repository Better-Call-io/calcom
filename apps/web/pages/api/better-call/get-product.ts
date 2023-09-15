import type { NextApiRequest, NextApiResponse } from "next";

import getProduct from "@calcom/stripepayment/lib/getProduct";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    try {
      const product = await getProduct(req.userId);
      res.status(200).json(product);
    } catch (err: any) {
      res.status(err.statusCode || 500).json(err.message);
    }
  } else {
    res.setHeader("Allow", "POST");
    res.status(405).end("Method Not Allowed");
  }
}
