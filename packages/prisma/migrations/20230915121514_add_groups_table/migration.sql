-- CreateTable
CREATE TABLE "Groups" (
    "id" SERIAL NOT NULL,
    "stripeProductId" TEXT NOT NULL,
    "userIds" INTEGER[],

    CONSTRAINT "Groups_pkey" PRIMARY KEY ("id")
);
