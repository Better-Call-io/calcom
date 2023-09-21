import stripe from "@calcom/app-store/stripepayment/lib/server";
import prisma from "@calcom/prisma";

export default async function getProduct(userId: number) {
  const product =
    (await prisma.groups.findFirst({
      where: {
        userIds: {
          has: userId,
        },
      },
    })) ||
    (await prisma.groups.findFirstOrThrow({
      where: {
        isBaseGroup: true,
      },
    }));
  const { stripeProductId } = product;
  if (!stripeProductId) throw new Error("No stripeProductId found for user " + userId);
  return await stripe.products.retrieve(product.stripeProductId, {
    expand: ["default_price"],
  });
}
