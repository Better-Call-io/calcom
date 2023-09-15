import type { NextApiRequest, NextApiResponse } from "next";

import stripe from "@calcom/stripepayment/lib/server";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "POST") {
    try {
      const product: any = await stripe.products.retrieve("prod_OdQwuy4cCH6Kvw", {
        expand: ["default_price"],
      });
      // Create Checkout Sessions from body params.
      const session: any = await stripe.checkout.sessions.create({
        customer_email: req.body.customerEmail,
        line_items: [
          {
            price: product.default_price.id,
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
