import stripe from "@calcom/app-store/stripepayment/lib/server";
import prisma from "@calcom/prisma";

export default async function getProduct(userId: number) {
  const { stripeProductId } = await prisma.groups.findFirstOrThrow({
    where: {
      userIds: {
        has: userId,
      },
    },
  });
  return await stripe.products.retrieve(stripeProductId, {
    expand: ["default_price"],
  });
}
