import type { NextApiRequest, NextApiResponse } from "next";

import stripe from "@calcom/app-store/stripepayment/lib/server";
import getProduct from "@calcom/stripepayment/lib/getProduct";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "POST") {
    try {
      const { default_price } = await getProduct(req.body.bookedUserId);
      const session = await stripe.checkout.sessions.create({
        customer_email: req.body.customerEmail,
        line_items: [
          {
            price: default_price.id,
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: `${req.headers.origin}/booking/${req.body.bookingUid}`,
        cancel_url: `${req.headers.origin}`,
      });
      res.status(200).json({ url: session.url });
    } catch (err: any) {
      res.status(err.statusCode || 500).json(err.message);
    }
  } else {
    res.setHeader("Allow", "POST");
    res.status(405).end("Method Not Allowed");
  }
}
