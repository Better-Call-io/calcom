import type { Prisma } from "@prisma/client";
import type { NextApiRequest, NextApiResponse } from "next";
import type Stripe from "stripe";

import EventManager from "@calcom/core/EventManager";
import { getCalEventResponses } from "@calcom/features/bookings/lib/getCalEventResponses";
import { handleConfirmation } from "@calcom/features/bookings/lib/handleConfirmation";
import { isPrismaObjOrUndefined } from "@calcom/lib";
import { HttpError as HttpCode } from "@calcom/lib/http-error";
import { getTranslation } from "@calcom/lib/server";
import { getTimeFormatStringFromUserTimeFormat } from "@calcom/lib/timeFormat";
import { BookingStatus } from "@calcom/prisma/enums";
import stripe from "@calcom/stripepayment/lib/server";
import type { CalendarEvent } from "@calcom/types/Calendar";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    throw new HttpCode({ statusCode: 405, message: "Not Allowed" });
  }
  const sig = req.headers["stripe-signature"];
  if (!sig) {
    throw new HttpCode({ statusCode: 400, message: "Missing stripe-signature" });
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw new HttpCode({ statusCode: 500, message: "Missing process.env.STRIPE_WEBHOOK_SECRET" });
  }
  const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

  if (event.type == "payment_intent.succeeded") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const payment = await prisma.payment.findFirst({
      where: {
        externalId: paymentIntent.id,
      },
      select: {
        id: true,
        bookingId: true,
      },
    });
    if (!payment?.bookingId) throw new HttpCode({ statusCode: 204, message: "Payment not found" });
    const booking = await prisma.booking.findUnique({
      where: { id: payment.bookingId },
      select: {
        id: true,
        title: true,
        description: true,
        customInputs: true,
        startTime: true,
        endTime: true,
        attendees: true,
        eventType: true,
        smsReminderNumber: true,
        location: true,
        eventTypeId: true,
        userId: true,
        uid: true,
        paid: true,
        destinationCalendar: true,
        status: true,
        responses: true,
        user: {
          select: {
            id: true,
            username: true,
            credentials: true,
            timeZone: true,
            timeFormat: true,
            email: true,
            name: true,
            locale: true,
            destinationCalendar: true,
          },
        },
      },
    });
    if (!booking) throw new HttpCode({ statusCode: 204, message: "No booking found" });
    if (!booking.user) throw new HttpCode({ statusCode: 204, message: "No user found" });
    const attendeesListPromises = booking.attendees.map(async (attendee) => {
      return {
        name: attendee.name,
        email: attendee.email,
        timeZone: attendee.timeZone,
        language: {
          translate: await getTranslation(attendee.locale ?? "en", "common"),
          locale: attendee.locale ?? "en",
        },
      };
    });

    const attendeesList = await Promise.all(attendeesListPromises);
    const selectedDestinationCalendar = booking.destinationCalendar || booking.user.destinationCalendar;
    const t = await getTranslation(booking.user.locale ?? "en", "common");
    const evt: CalendarEvent = {
      type: booking.title,
      title: booking.title,
      description: booking.description || undefined,
      startTime: booking.startTime.toISOString(),
      endTime: booking.endTime.toISOString(),
      customInputs: isPrismaObjOrUndefined(booking.customInputs),
      ...getCalEventResponses({
        booking: booking,
        bookingFields: booking.eventType?.bookingFields || null,
      }),
      organizer: {
        email: booking.user.email,
        name: booking.user.name!,
        timeZone: booking.user.timeZone,
        timeFormat: getTimeFormatStringFromUserTimeFormat(booking.user.timeFormat),
        language: { translate: t, locale: booking.user.locale ?? "en" },
      },
      attendees: attendeesList,
      location: booking.location,
      uid: booking.uid,
      destinationCalendar: selectedDestinationCalendar ? [selectedDestinationCalendar] : [],
      recurringEvent: null,
    };
    const bookingData: Prisma.BookingUpdateInput = {
      paid: true,
      status: BookingStatus.ACCEPTED,
    };
    const isConfirmed = booking.status === BookingStatus.ACCEPTED;
    if (isConfirmed) {
      const eventManager = new EventManager(booking.user);
      const scheduleResult = await eventManager.create(evt);
      bookingData.references = { create: scheduleResult.referencesToCreate };
    }
    const paymentUpdate = prisma.payment.update({
      where: {
        id: payment.id,
      },
      data: {
        success: true,
      },
    });

    const bookingUpdate = prisma.booking.update({
      where: {
        id: booking.id,
      },
      data: bookingData,
    });
    await prisma.$transaction([paymentUpdate, bookingUpdate]);
    await handleConfirmation({
      user: booking.user,
      evt,
      prisma,
      bookingId: booking.id,
      booking,
      paid: true,
    });
  }
  res.json({ received: true });
}
