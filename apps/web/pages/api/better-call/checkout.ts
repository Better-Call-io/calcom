import type { NextApiRequest, NextApiResponse } from "next";
import englishTranslations from "public/static/locales/en/common.json";
import frenchTranslations from "public/static/locales/fr/common.json";

import stripe from "@calcom/app-store/stripepayment/lib/server";
import { getLocaleFromRequest } from "@calcom/lib/getLocaleFromRequest";
import getProduct from "@calcom/stripepayment/lib/getProduct";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "POST") {
    try {
      const bookingUid = req.body.bookingUid;
      const {
        default_price: { id },
      } = await getProduct(req.body.bookedUserId);
      const locale = await getLocaleFromRequest(req);
      const session = await stripe.checkout.sessions.create({
        customer_email: req.body.customerEmail,
        line_items: [
          {
            price: id,
            quantity: 1,
          },
        ],
        mode: "payment",
        invoice_creation: { enabled: true },
        metadata: { bookingUid },
        success_url: `${req.headers.origin}/booking/${bookingUid}`,
        automatic_tax: { enabled: true },
        custom_text: {
          submit: {
            message:
              locale === "fr"
                ? frenchTranslations["we_do_not_accept_cancellations"]
                : englishTranslations["we_do_not_accept_cancellations"],
          },
        },
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
