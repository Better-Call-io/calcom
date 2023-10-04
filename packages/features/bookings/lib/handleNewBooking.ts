import type { Attendee, DestinationCalendar, EventTypeCustomInput } from "@prisma/client";
import { Prisma } from "@prisma/client";
import async from "async";
import { isValidPhoneNumber } from "libphonenumber-js";
// eslint-disable-next-line no-restricted-imports
import { cloneDeep } from "lodash";
import type { NextApiRequest } from "next";
import short, { uuid } from "short-uuid";
import { v5 as uuidv5 } from "uuid";
import z from "zod";

import { getCalendar } from "@calcom/app-store/_utils/getCalendar";
import type { LocationObject } from "@calcom/app-store/locations";
import { getLocationValueForDB, OrganizerDefaultConferencingAppType } from "@calcom/app-store/locations";
import { getAppFromSlug } from "@calcom/app-store/utils";
import EventManager from "@calcom/core/EventManager";
import { getEventName } from "@calcom/core/event";
import { getUserAvailability } from "@calcom/core/getUserAvailability";
import { deleteMeeting } from "@calcom/core/videoClient";
import dayjs from "@calcom/dayjs";
import { sendRescheduledEmails } from "@calcom/emails";
import { getBookingFieldsWithSystemFields } from "@calcom/features/bookings/lib/getBookingFields";
import { getCalEventResponses } from "@calcom/features/bookings/lib/getCalEventResponses";
import { isEventTypeOwnerKYCVerified } from "@calcom/features/ee/workflows/lib/isEventTypeOwnerKYCVerified";
import { cancelWorkflowReminders } from "@calcom/features/ee/workflows/lib/reminders/reminderScheduler";
import { getFullName } from "@calcom/features/form-builder/utils";
import type { GetSubscriberOptions } from "@calcom/features/webhooks/lib/getWebhooks";
import { isPrismaObjOrUndefined, parseRecurringEvent } from "@calcom/lib";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import { getDefaultEvent, getUsernameList } from "@calcom/lib/defaultEvents";
import { getErrorFromUnknown } from "@calcom/lib/errors";
import getIP from "@calcom/lib/getIP";
import getPaymentAppData from "@calcom/lib/getPaymentAppData";
import { getTeamIdFromEventType } from "@calcom/lib/getTeamIdFromEventType";
import { HttpError } from "@calcom/lib/http-error";
import isOutOfBounds, { BookingDateInPastError } from "@calcom/lib/isOutOfBounds";
import logger from "@calcom/lib/logger";
import { checkBookingLimits, checkDurationLimits, getLuckyUser } from "@calcom/lib/server";
import { getBookerUrl } from "@calcom/lib/server/getBookerUrl";
import { getTranslation } from "@calcom/lib/server/i18n";
import { slugify } from "@calcom/lib/slugify";
import { updateWebUser as syncServicesUpdateWebUser } from "@calcom/lib/sync/SyncServiceManager";
import { getTimeFormatStringFromUserTimeFormat } from "@calcom/lib/timeFormat";
import prisma, { userSelect } from "@calcom/prisma";
import type { BookingReference } from "@calcom/prisma/client";
import { BookingStatus, SchedulingType, WebhookTriggerEvents } from "@calcom/prisma/enums";
import { credentialForCalendarServiceSelect } from "@calcom/prisma/selects/credential";
import {
  bookingCreateBodySchemaForApi,
  bookingCreateSchemaLegacyPropsForApi,
  customInputSchema,
  EventTypeMetaDataSchema,
  extendedBookingCreateBody,
  userMetadata as userMetadataSchema,
} from "@calcom/prisma/zod-utils";
import type { BufferedBusyTime } from "@calcom/types/BufferedBusyTime";
import type { AdditionalInformation, AppsStatus, CalendarEvent, IntervalLimit } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { EventResult, PartialReference } from "@calcom/types/EventManager";

import type { EventTypeInfo } from "../../webhooks/lib/sendPayload";
import getBookingResponsesSchema from "./getBookingResponsesSchema";

const translator = short();
const log = logger.getChildLogger({ prefix: ["[api] book:user"] });

type User = Prisma.UserGetPayload<typeof userSelect>;
type BufferedBusyTimes = BufferedBusyTime[];
type BookingType = Prisma.PromiseReturnType<typeof getOriginalRescheduledBooking>;

/**
 * Refreshes a Credential with fresh data from the database.
 *
 * @param credential
 */
async function refreshCredential(credential: CredentialPayload): Promise<CredentialPayload> {
  const newCredential = await prisma.credential.findUnique({
    where: {
      id: credential.id,
    },
    select: credentialForCalendarServiceSelect,
  });

  if (!newCredential) {
    return credential;
  } else {
    return newCredential;
  }
}

/**
 * Refreshes the given set of credentials.
 *
 * @param credentials
 */
async function refreshCredentials(credentials: Array<CredentialPayload>): Promise<Array<CredentialPayload>> {
  return await async.mapLimit(credentials, 5, refreshCredential);
}

/**
 * Gets credentials from the user, team, and org if applicable
 *
 */
const getAllCredentials = async (
  user: User & { credentials: CredentialPayload[] },
  eventType: Awaited<ReturnType<typeof getEventTypesFromDB>>
) => {
  const allCredentials = user.credentials;

  // If it's a team event type query for team credentials
  if (eventType.team?.id) {
    const teamCredentialsQuery = await prisma.credential.findMany({
      where: {
        teamId: eventType.team.id,
      },
      select: credentialForCalendarServiceSelect,
    });
    allCredentials.push(...teamCredentialsQuery);
  }

  // If it's a managed event type, query for the parent team's credentials
  if (eventType.parentId) {
    const teamCredentialsQuery = await prisma.team.findFirst({
      where: {
        eventTypes: {
          some: {
            id: eventType.parentId,
          },
        },
      },
      select: {
        credentials: {
          select: credentialForCalendarServiceSelect,
        },
      },
    });
    if (teamCredentialsQuery?.credentials) {
      allCredentials.push(...teamCredentialsQuery?.credentials);
    }
  }

  // If the user is a part of an organization, query for the organization's credentials
  if (user?.organizationId) {
    const org = await prisma.team.findUnique({
      where: {
        id: user.organizationId,
      },
      select: {
        credentials: {
          select: credentialForCalendarServiceSelect,
        },
      },
    });

    if (org?.credentials) {
      allCredentials.push(...org.credentials);
    }
  }

  return allCredentials;
};

// if true, there are conflicts.
function checkForConflicts(busyTimes: BufferedBusyTimes, time: dayjs.ConfigType, length: number) {
  // Early return
  if (!Array.isArray(busyTimes) || busyTimes.length < 1) {
    return false; // guaranteed no conflicts when there is no busy times.
  }

  for (const busyTime of busyTimes) {
    const startTime = dayjs(busyTime.start);
    const endTime = dayjs(busyTime.end);
    // Check if time is between start and end times
    if (dayjs(time).isBetween(startTime, endTime, null, "[)")) {
      log.error(
        `NAUF: start between a busy time slot ${JSON.stringify({
          ...busyTime,
          time: dayjs(time).format(),
        })}`
      );
      return true;
    }
    // Check if slot end time is between start and end time
    if (dayjs(time).add(length, "minutes").isBetween(startTime, endTime)) {
      log.error(
        `NAUF: Ends between a busy time slot ${JSON.stringify({
          ...busyTime,
          time: dayjs(time).add(length, "minutes").format(),
        })}`
      );
      return true;
    }
    // Check if startTime is between slot
    if (startTime.isBetween(dayjs(time), dayjs(time).add(length, "minutes"))) {
      return true;
    }
  }
  return false;
}

const getEventTypesFromDB = async (eventTypeId: number) => {
  const eventType = await prisma.eventType.findUniqueOrThrow({
    where: {
      id: eventTypeId,
    },
    select: {
      id: true,
      customInputs: true,
      disableGuests: true,
      users: {
        select: {
          credentials: {
            select: credentialForCalendarServiceSelect,
          },
          ...userSelect.select,
        },
      },
      slug: true,
      team: {
        select: {
          id: true,
          name: true,
          metadata: true,
        },
      },
      bookingFields: true,
      title: true,
      length: true,
      eventName: true,
      schedulingType: true,
      description: true,
      periodType: true,
      periodStartDate: true,
      periodEndDate: true,
      periodDays: true,
      periodCountCalendarDays: true,
      requiresConfirmation: true,
      requiresBookerEmailVerification: true,
      userId: true,
      price: true,
      currency: true,
      metadata: true,
      destinationCalendar: true,
      hideCalendarNotes: true,
      seatsPerTimeSlot: true,
      recurringEvent: true,
      seatsShowAttendees: true,
      seatsShowAvailabilityCount: true,
      bookingLimits: true,
      durationLimits: true,
      parentId: true,
      owner: {
        select: {
          hideBranding: true,
          metadata: true,
          teams: {
            select: {
              accepted: true,
              team: {
                select: {
                  metadata: true,
                },
              },
            },
          },
        },
      },
      workflows: {
        include: {
          workflow: {
            include: {
              steps: true,
            },
          },
        },
      },
      locations: true,
      timeZone: true,
      schedule: {
        select: {
          availability: true,
          timeZone: true,
        },
      },
      hosts: {
        select: {
          isFixed: true,
          user: {
            select: {
              credentials: {
                select: credentialForCalendarServiceSelect,
              },
              ...userSelect.select,
              organization: {
                select: {
                  slug: true,
                },
              },
            },
          },
        },
      },
      availability: {
        select: {
          date: true,
          startTime: true,
          endTime: true,
          days: true,
        },
      },
    },
  });

  return {
    ...eventType,
    metadata: EventTypeMetaDataSchema.parse(eventType?.metadata || {}),
    recurringEvent: parseRecurringEvent(eventType?.recurringEvent),
    customInputs: customInputSchema.array().parse(eventType?.customInputs || []),
    locations: (eventType?.locations ?? []) as LocationObject[],
    bookingFields: getBookingFieldsWithSystemFields(eventType || {}),
    isDynamic: false,
  };
};

type IsFixedAwareUser = User & {
  isFixed: boolean;
  credentials: CredentialPayload[];
  organization: { slug: string };
};

async function ensureAvailableUsers(
  eventType: Awaited<ReturnType<typeof getEventTypesFromDB>> & {
    users: IsFixedAwareUser[];
  },
  input: { dateFrom: string; dateTo: string; timeZone: string; originalRescheduledBooking?: BookingType },
  recurringDatesInfo?: {
    allRecurringDates: string[] | undefined;
    currentRecurringIndex: number | undefined;
  }
) {
  const availableUsers: IsFixedAwareUser[] = [];
  const duration = dayjs(input.dateTo).diff(input.dateFrom, "minute");

  const originalBookingDuration = input.originalRescheduledBooking
    ? dayjs(input.originalRescheduledBooking.endTime).diff(
        dayjs(input.originalRescheduledBooking.startTime),
        "minutes"
      )
    : undefined;

  /** Let's start checking for availability */
  for (const user of eventType.users) {
    const { dateRanges, busy: bufferedBusyTimes } = await getUserAvailability(
      {
        userId: user.id,
        eventTypeId: eventType.id,
        duration: originalBookingDuration,
        ...input,
      },
      {
        user,
        eventType,
        rescheduleUid: input.originalRescheduledBooking?.uid ?? null,
      }
    );

    if (!dateRanges.length) {
      // user does not have availability at this time, skip user.
      continue;
    }

    console.log("calendarBusyTimes==>>>", bufferedBusyTimes);

    let foundConflict = false;
    try {
      if (
        eventType.recurringEvent &&
        recurringDatesInfo?.currentRecurringIndex === 0 &&
        recurringDatesInfo.allRecurringDates
      ) {
        const allBookingDates = recurringDatesInfo.allRecurringDates.map((strDate) => new Date(strDate));
        // Go through each date for the recurring event and check if each one's availability
        // DONE: Decreased computational complexity from O(2^n) to O(n) by refactoring this loop to stop
        // running at the first unavailable time.
        let i = 0;
        while (!foundConflict && i < allBookingDates.length) {
          foundConflict = checkForConflicts(bufferedBusyTimes, allBookingDates[i++], duration);
        }
      } else {
        foundConflict = checkForConflicts(bufferedBusyTimes, input.dateFrom, duration);
      }
    } catch {
      log.debug({
        message: "Unable set isAvailableToBeBooked. Using true. ",
      });
    }
    // no conflicts found, add to available users.
    if (!foundConflict) {
      availableUsers.push(user);
    }
  }
  if (!availableUsers.length) {
    throw new Error("No available users found.");
  }
  return availableUsers;
}

async function getOriginalRescheduledBooking(uid: string, seatsEventType?: boolean) {
  return prisma.booking.findFirst({
    where: {
      uid: uid,
      status: {
        in: [BookingStatus.ACCEPTED, BookingStatus.CANCELLED, BookingStatus.PENDING],
      },
    },
    include: {
      attendees: {
        select: {
          name: true,
          email: true,
          locale: true,
          timeZone: true,
          ...(seatsEventType && { bookingSeat: true, id: true }),
        },
      },
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          locale: true,
          timeZone: true,
        },
      },
      payment: true,
      references: true,
      workflowReminders: true,
    },
  });
}

async function getBookingData({
  req,
  isNotAnApiCall,
  eventType,
}: {
  req: NextApiRequest;
  isNotAnApiCall: boolean;
  eventType: Awaited<ReturnType<typeof getEventTypesFromDB>>;
}) {
  const responsesSchema = getBookingResponsesSchema({
    eventType: {
      bookingFields: eventType.bookingFields,
    },
    view: req.body.rescheduleUid ? "reschedule" : "booking",
  });
  const bookingDataSchema = isNotAnApiCall
    ? extendedBookingCreateBody.merge(
        z.object({
          responses: responsesSchema,
        })
      )
    : bookingCreateBodySchemaForApi
        .merge(
          z.object({
            responses: responsesSchema.optional(),
          })
        )
        .superRefine((val, ctx) => {
          if (val.responses && val.customInputs) {
            ctx.addIssue({
              code: "custom",
              message:
                "Don't use both customInputs and responses. `customInputs` is only there for legacy support.",
            });
            return;
          }
          const legacyProps = Object.keys(bookingCreateSchemaLegacyPropsForApi.shape);

          if (val.responses) {
            const unwantedProps: string[] = [];
            legacyProps.forEach((legacyProp) => {
              if (typeof val[legacyProp as keyof typeof val] !== "undefined") {
                console.error(
                  `Deprecated: Unexpected falsy value for: ${unwantedProps.join(
                    ","
                  )}. They can't be used with \`responses\`. This will become a 400 error in the future.`
                );
              }
              if (val[legacyProp as keyof typeof val]) {
                unwantedProps.push(legacyProp);
              }
            });
            if (unwantedProps.length) {
              ctx.addIssue({
                code: "custom",
                message: `Legacy Props: ${unwantedProps.join(",")}. They can't be used with \`responses\``,
              });
              return;
            }
          } else if (val.customInputs) {
            const { success } = bookingCreateSchemaLegacyPropsForApi.safeParse(val);
            if (!success) {
              ctx.addIssue({
                code: "custom",
                message: `With \`customInputs\` you must specify legacy props ${legacyProps.join(",")}`,
              });
            }
          }
        });

  const reqBody = await bookingDataSchema.parseAsync(req.body);

  // Work with Typescript to require reqBody.end
  type ReqBodyWithoutEnd = z.infer<typeof bookingDataSchema>;
  type ReqBodyWithEnd = ReqBodyWithoutEnd & { end: string };

  const reqBodyWithEnd = (reqBody: ReqBodyWithoutEnd): reqBody is ReqBodyWithEnd => {
    // Use the event length to auto-set the event end time.
    if (!Object.prototype.hasOwnProperty.call(reqBody, "end")) {
      reqBody.end = dayjs.utc(reqBody.start).add(eventType.length, "minutes").format();
    }
    return true;
  };
  if (!reqBodyWithEnd(reqBody)) {
    throw new Error("Internal Error.");
  }
  // reqBody.end is no longer an optional property.
  if ("customInputs" in reqBody) {
    if (reqBody.customInputs) {
      // Check if required custom inputs exist
      handleCustomInputs(eventType.customInputs as EventTypeCustomInput[], reqBody.customInputs);
    }
    const reqBodyWithLegacyProps = bookingCreateSchemaLegacyPropsForApi.parse(reqBody);
    return {
      ...reqBody,
      name: reqBodyWithLegacyProps.name,
      email: reqBodyWithLegacyProps.email,
      guests: reqBodyWithLegacyProps.guests,
      location: reqBodyWithLegacyProps.location || "",
      smsReminderNumber: reqBodyWithLegacyProps.smsReminderNumber,
      notes: reqBodyWithLegacyProps.notes,
      rescheduleReason: reqBodyWithLegacyProps.rescheduleReason,
    };
  } else {
    if (!reqBody.responses) {
      throw new Error("`responses` must not be nullish");
    }
    const responses = reqBody.responses;

    const { userFieldsResponses: calEventUserFieldsResponses, responses: calEventResponses } =
      getCalEventResponses({
        bookingFields: eventType.bookingFields,
        responses,
      });
    return {
      ...reqBody,
      name: responses.name,
      email: responses.email,
      guests: responses.guests ? responses.guests : [],
      location: responses.location?.optionValue || responses.location?.value || "",
      smsReminderNumber: responses.smsReminderNumber,
      notes: responses.notes || "",
      calEventUserFieldsResponses,
      rescheduleReason: responses.rescheduleReason,
      calEventResponses,
    };
  }
}

function getCustomInputsResponses(
  reqBody: {
    responses?: Record<string, object>;
    customInputs?: z.infer<typeof bookingCreateSchemaLegacyPropsForApi>["customInputs"];
  },
  eventTypeCustomInputs: Awaited<ReturnType<typeof getEventTypesFromDB>>["customInputs"]
) {
  const customInputsResponses = {} as NonNullable<CalendarEvent["customInputs"]>;
  if ("customInputs" in reqBody) {
    const reqCustomInputsResponses = reqBody.customInputs || [];
    if (reqCustomInputsResponses?.length > 0) {
      reqCustomInputsResponses.forEach(({ label, value }) => {
        customInputsResponses[label] = value;
      });
    }
  } else {
    const responses = reqBody.responses || {};
    // Backward Compatibility: Map new `responses` to old `customInputs` format so that webhooks can still receive same values.
    for (const [fieldName, fieldValue] of Object.entries(responses)) {
      const foundACustomInputForTheResponse = eventTypeCustomInputs.find(
        (input) => slugify(input.label) === fieldName
      );
      if (foundACustomInputForTheResponse) {
        customInputsResponses[foundACustomInputForTheResponse.label] = fieldValue;
      }
    }
  }

  return customInputsResponses;
}

async function handler(
  req: NextApiRequest & { userId?: number | undefined },
  {
    isNotAnApiCall = false,
  }: {
    isNotAnApiCall?: boolean;
  } = {
    isNotAnApiCall: false,
  }
) {
  const { userId } = req;

  const userIp = getIP(req);

  await checkRateLimitAndThrowError({
    rateLimitingType: "core",
    identifier: userIp,
  });

  // handle dynamic user
  let eventType =
    !req.body.eventTypeId && !!req.body.eventTypeSlug
      ? getDefaultEvent(req.body.eventTypeSlug)
      : await getEventTypesFromDB(req.body.eventTypeId);

  eventType = {
    ...eventType,
    bookingFields: getBookingFieldsWithSystemFields(eventType),
  };
  const {
    recurringCount,
    allRecurringDates,
    currentRecurringIndex,
    noEmail,
    eventTypeId,
    eventTypeSlug,
    hasHashedBookingLink,
    language,
    appsStatus: reqAppsStatus,
    name: bookerName,
    email: bookerEmail,
    guests: reqGuests,
    location,
    notes: additionalNotes,
    smsReminderNumber,
    rescheduleReason,
    ...reqBody
  } = await getBookingData({
    req,
    isNotAnApiCall,
    eventType,
  });

  const fullName = getFullName(bookerName);

  const tGuests = await getTranslation("en", "common");
  log.debug(`Booking eventType ${eventTypeId} started`);
  const dynamicUserList = Array.isArray(reqBody.user) ? reqBody.user : getUsernameList(reqBody.user);
  if (!eventType) throw new HttpError({ statusCode: 404, message: "eventType.notFound" });

  const isTeamEventType =
    !!eventType.schedulingType && ["COLLECTIVE", "ROUND_ROBIN"].includes(eventType.schedulingType);

  const paymentAppData = getPaymentAppData(eventType);

  let timeOutOfBounds = false;
  try {
    timeOutOfBounds = isOutOfBounds(reqBody.start, {
      periodType: eventType.periodType,
      periodDays: eventType.periodDays,
      periodEndDate: eventType.periodEndDate,
      periodStartDate: eventType.periodStartDate,
      periodCountCalendarDays: eventType.periodCountCalendarDays,
    });
  } catch (error) {
    log.warn({
      message: "NewBooking: Unable set timeOutOfBounds. Using false. ",
    });
    if (error instanceof BookingDateInPastError) {
      // TODO: HttpError should not bleed through to the console.
      log.info(`Booking eventType ${eventTypeId} failed`, error);
      throw new HttpError({ statusCode: 400, message: error.message });
    }
  }

  if (timeOutOfBounds) {
    const error = {
      errorCode: "BookingTimeOutOfBounds",
      message: `EventType '${eventType.eventName}' cannot be booked at this time.`,
    };
    log.warn({
      message: `NewBooking: EventType '${eventType.eventName}' cannot be booked at this time.`,
    });
    throw new HttpError({ statusCode: 400, message: error.message });
  }

  const loadUsers = async () => {
    try {
      if (!eventTypeId) {
        if (!Array.isArray(dynamicUserList) || dynamicUserList.length === 0) {
          throw new Error("dynamicUserList is not properly defined or empty.");
        }

        const users = await prisma.user.findMany({
          where: {
            username: { in: dynamicUserList },
          },
          select: {
            ...userSelect.select,
            credentials: {
              select: credentialForCalendarServiceSelect,
            },
            metadata: true,
          },
        });

        return users;
      } else {
        const hosts = eventType.hosts || [];

        if (!Array.isArray(hosts)) {
          throw new Error("eventType.hosts is not properly defined.");
        }

        const users = hosts.map(({ user, isFixed }) => ({
          ...user,
          isFixed,
        }));

        return users.length ? users : eventType.users;
      }
    } catch (error) {
      if (error instanceof HttpError || error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new HttpError({ statusCode: 400, message: error.message });
      }
      throw new HttpError({ statusCode: 500, message: "Unable to load users" });
    }
  };
  // loadUsers allows type inferring
  let users: (Awaited<ReturnType<typeof loadUsers>>[number] & {
    isFixed?: boolean;
    metadata?: Prisma.JsonValue;
  })[] = await loadUsers();

  const isDynamicAllowed = !users.some((user) => !user.allowDynamicBooking);
  if (!isDynamicAllowed && !eventTypeId) {
    log.warn({ message: "NewBooking: Some of the users in this group do not allow dynamic booking" });
    throw new HttpError({
      message: "Some of the users in this group do not allow dynamic booking",
      statusCode: 400,
    });
  }

  // If this event was pre-relationship migration
  // TODO: Establish whether this is dead code.
  if (!users.length && eventType.userId) {
    const eventTypeUser = await prisma.user.findUnique({
      where: {
        id: eventType.userId,
      },
      select: {
        credentials: {
          select: credentialForCalendarServiceSelect,
        }, // Don't leak to client
        ...userSelect.select,
      },
    });
    if (!eventTypeUser) {
      log.warn({ message: "NewBooking: eventTypeUser.notFound" });
      throw new HttpError({ statusCode: 404, message: "eventTypeUser.notFound" });
    }
    users.push(eventTypeUser);
  }

  if (!users) throw new HttpError({ statusCode: 404, message: "eventTypeUser.notFound" });

  users = users.map((user) => ({
    ...user,
    isFixed:
      user.isFixed === false
        ? false
        : user.isFixed || eventType.schedulingType !== SchedulingType.ROUND_ROBIN,
  }));

  let locationBodyString = location;

  // TODO: It's definition should be moved to getLocationValueForDb
  let organizerOrFirstDynamicGroupMemberDefaultLocationUrl = undefined;

  if (dynamicUserList.length > 1) {
    users = users.sort((a, b) => {
      const aIndex = (a.username && dynamicUserList.indexOf(a.username)) || 0;
      const bIndex = (b.username && dynamicUserList.indexOf(b.username)) || 0;
      return aIndex - bIndex;
    });
    const firstUsersMetadata = userMetadataSchema.parse(users[0].metadata);
    locationBodyString = firstUsersMetadata?.defaultConferencingApp?.appLink || locationBodyString;
    organizerOrFirstDynamicGroupMemberDefaultLocationUrl =
      firstUsersMetadata?.defaultConferencingApp?.appLink;
  }

  if (
    Object.prototype.hasOwnProperty.call(eventType, "bookingLimits") ||
    Object.prototype.hasOwnProperty.call(eventType, "durationLimits")
  ) {
    const startAsDate = dayjs(reqBody.start).toDate();
    if (eventType.bookingLimits) {
      await checkBookingLimits(eventType.bookingLimits as IntervalLimit, startAsDate, eventType.id);
    }
    if (eventType.durationLimits) {
      await checkDurationLimits(eventType.durationLimits as IntervalLimit, startAsDate, eventType.id);
    }
  }

  let rescheduleUid = reqBody.rescheduleUid;
  let bookingSeat: Prisma.BookingSeatGetPayload<{ include: { booking: true; attendee: true } }> | null = null;

  let originalRescheduledBooking: BookingType = null;

  if (rescheduleUid) {
    // rescheduleUid can be bookingUid and bookingSeatUid
    bookingSeat = await prisma.bookingSeat.findUnique({
      where: {
        referenceUid: rescheduleUid,
      },
      include: {
        booking: true,
        attendee: true,
      },
    });
    if (bookingSeat) {
      rescheduleUid = bookingSeat.booking.uid;
    }
    originalRescheduledBooking = await getOriginalRescheduledBooking(
      rescheduleUid,
      !!eventType.seatsPerTimeSlot
    );
    if (!originalRescheduledBooking) {
      throw new HttpError({ statusCode: 404, message: "Could not find original booking" });
    }
  }

  if (!eventType.seatsPerTimeSlot) {
    const availableUsers = await ensureAvailableUsers(
      {
        ...eventType,
        users: users as IsFixedAwareUser[],
        ...(eventType.recurringEvent && {
          recurringEvent: {
            ...eventType.recurringEvent,
            count: recurringCount || eventType.recurringEvent.count,
          },
        }),
      },
      {
        dateFrom: reqBody.start,
        dateTo: reqBody.end,
        timeZone: reqBody.timeZone,
        originalRescheduledBooking,
      },
      {
        allRecurringDates,
        currentRecurringIndex,
      }
    );

    const luckyUsers: typeof users = [];
    const luckyUserPool = availableUsers.filter((user) => !user.isFixed);
    // loop through all non-fixed hosts and get the lucky users
    while (luckyUserPool.length > 0 && luckyUsers.length < 1 /* TODO: Add variable */) {
      const newLuckyUser = await getLuckyUser("MAXIMIZE_AVAILABILITY", {
        // find a lucky user that is not already in the luckyUsers array
        availableUsers: luckyUserPool.filter(
          (user) => !luckyUsers.find((existing) => existing.id === user.id)
        ),
        eventTypeId: eventType.id,
      });
      if (!newLuckyUser) {
        break; // prevent infinite loop
      }
      luckyUsers.push(newLuckyUser);
    }
    // ALL fixed users must be available
    if (
      availableUsers.filter((user) => user.isFixed).length !== users.filter((user) => user.isFixed).length
    ) {
      throw new Error("Some users are unavailable for booking.");
    }
    // Pushing fixed user before the luckyUser guarantees the (first) fixed user as the organizer.
    users = [...availableUsers.filter((user) => user.isFixed), ...luckyUsers];
  }

  const [organizerUser] = users;
  const tOrganizer = await getTranslation(organizerUser?.locale ?? "en", "common");

  const allCredentials = await getAllCredentials(organizerUser, eventType);

  const isOrganizerRescheduling = organizerUser.id === userId;

  const attendeeInfoOnReschedule =
    isOrganizerRescheduling && originalRescheduledBooking
      ? originalRescheduledBooking.attendees.find((attendee) => attendee.email === bookerEmail)
      : null;

  const attendeeLanguage = attendeeInfoOnReschedule ? attendeeInfoOnReschedule.locale : language;
  const attendeeTimezone = attendeeInfoOnReschedule ? attendeeInfoOnReschedule.timeZone : reqBody.timeZone;

  const tAttendees = await getTranslation(attendeeLanguage ?? "en", "common");

  // use host default
  if (isTeamEventType && locationBodyString === OrganizerDefaultConferencingAppType) {
    const metadataParseResult = userMetadataSchema.safeParse(organizerUser.metadata);
    const organizerMetadata = metadataParseResult.success ? metadataParseResult.data : undefined;
    if (organizerMetadata) {
      const app = getAppFromSlug(organizerMetadata?.defaultConferencingApp?.appSlug);
      locationBodyString = app?.appData?.location?.type || locationBodyString;
      organizerOrFirstDynamicGroupMemberDefaultLocationUrl =
        organizerMetadata?.defaultConferencingApp?.appLink;
    } else {
      locationBodyString = "";
    }
  }

  const invitee = [
    {
      email: bookerEmail,
      name: fullName,
      firstName: (typeof bookerName === "object" && bookerName.firstName) || "",
      lastName: (typeof bookerName === "object" && bookerName.lastName) || "",
      timeZone: attendeeTimezone,
      language: { translate: tAttendees, locale: attendeeLanguage ?? "en" },
    },
  ];

  const guests = (reqGuests || []).reduce((guestArray, guest) => {
    // If it's a team event, remove the team member from guests
    if (isTeamEventType && users.some((user) => user.email === guest)) {
      return guestArray;
    }
    guestArray.push({
      email: guest,
      name: "",
      firstName: "",
      lastName: "",
      timeZone: attendeeTimezone,
      language: { translate: tGuests, locale: "en" },
    });
    return guestArray;
  }, [] as typeof invitee);

  const seed = `${organizerUser.username}:${dayjs(reqBody.start).utc().format()}:${new Date().getTime()}`;
  const uid = translator.fromUUID(uuidv5(seed, uuidv5.URL));

  // For static link based video apps, it would have the static URL value instead of it's type(e.g. integrations:campfire_video)
  // This ensures that createMeeting isn't called for static video apps as bookingLocation becomes just a regular value for them.
  const { bookingLocation, conferenceCredentialId } = organizerOrFirstDynamicGroupMemberDefaultLocationUrl
    ? {
        bookingLocation: organizerOrFirstDynamicGroupMemberDefaultLocationUrl,
        conferenceCredentialId: undefined,
      }
    : getLocationValueForDB(locationBodyString, eventType.locations);

  const customInputs = getCustomInputsResponses(reqBody, eventType.customInputs);
  const teamDestinationCalendars: DestinationCalendar[] = [];

  // Organizer or user owner of this event type it's not listed as a team member.
  const teamMemberPromises = users.slice(1).map(async (user) => {
    // push to teamDestinationCalendars if it's a team event but collective only
    if (isTeamEventType && eventType.schedulingType === "COLLECTIVE" && user.destinationCalendar) {
      teamDestinationCalendars.push(user.destinationCalendar);
    }
    return {
      id: user.id,
      email: user.email ?? "",
      name: user.name ?? "",
      firstName: "",
      lastName: "",
      timeZone: user.timeZone,
      language: {
        translate: await getTranslation(user.locale ?? "en", "common"),
        locale: user.locale ?? "en",
      },
    };
  });

  const teamMembers = await Promise.all(teamMemberPromises);

  const attendeesList = [...invitee, ...guests];

  const responses = "responses" in reqBody ? reqBody.responses : null;

  const evtName = !eventType?.isDynamic ? eventType.eventName : responses?.title;
  const eventNameObject = {
    //TODO: Can we have an unnamed attendee? If not, I would really like to throw an error here.
    attendeeName: fullName || "Nameless",
    eventType: eventType.title,
    eventName: evtName,
    // we send on behalf of team if >1 round robin attendee | collective
    teamName: eventType.schedulingType === "COLLECTIVE" || users.length > 1 ? eventType.team?.name : null,
    // TODO: Can we have an unnamed organizer? If not, I would really like to throw an error here.
    host: organizerUser.name || "Nameless",
    location: bookingLocation,
    bookingFields: { ...responses },
    t: tOrganizer,
  };

  let requiresConfirmation = eventType?.requiresConfirmation;
  const rcThreshold = eventType?.metadata?.requiresConfirmationThreshold;
  if (rcThreshold) {
    if (dayjs(dayjs(reqBody.start).utc().format()).diff(dayjs(), rcThreshold.unit) > rcThreshold.time) {
      requiresConfirmation = false;
    }
  }

  const calEventUserFieldsResponses =
    "calEventUserFieldsResponses" in reqBody ? reqBody.calEventUserFieldsResponses : null;

  const evt: CalendarEvent = {
    bookerUrl: await getBookerUrl(organizerUser),
    type: eventType.title,
    title: getEventName(eventNameObject), //this needs to be either forced in english, or fetched for each attendee and organizer separately
    description: eventType.description,
    additionalNotes,
    customInputs,
    startTime: dayjs(reqBody.start).utc().format(),
    endTime: dayjs(reqBody.end).utc().format(),
    organizer: {
      id: organizerUser.id,
      name: organizerUser.name || "Nameless",
      email: organizerUser.email || "Email-less",
      username: organizerUser.username || undefined,
      timeZone: organizerUser.timeZone,
      language: { translate: tOrganizer, locale: organizerUser.locale ?? "en" },
      timeFormat: getTimeFormatStringFromUserTimeFormat(organizerUser.timeFormat),
    },
    responses: "calEventResponses" in reqBody ? reqBody.calEventResponses : null,
    userFieldsResponses: calEventUserFieldsResponses,
    attendees: attendeesList,
    location: bookingLocation, // Will be processed by the EventManager later.
    conferenceCredentialId,
    destinationCalendar: eventType.destinationCalendar
      ? [eventType.destinationCalendar]
      : organizerUser.destinationCalendar
      ? [organizerUser.destinationCalendar]
      : null,
    hideCalendarNotes: eventType.hideCalendarNotes,
    requiresConfirmation: requiresConfirmation ?? false,
    eventTypeId: eventType.id,
    // if seats are not enabled we should default true
    seatsShowAttendees: eventType.seatsPerTimeSlot ? eventType.seatsShowAttendees : true,
    seatsPerTimeSlot: eventType.seatsPerTimeSlot,
    seatsShowAvailabilityCount: eventType.seatsPerTimeSlot ? eventType.seatsShowAvailabilityCount : true,
    schedulingType: eventType.schedulingType,
  };

  if (isTeamEventType && eventType.schedulingType === "COLLECTIVE") {
    evt.destinationCalendar?.push(...teamDestinationCalendars);
  }

  /* Used for seats bookings to update evt object with video data */
  const addVideoCallDataToEvt = (bookingReferences: BookingReference[]) => {
    const videoCallReference = bookingReferences.find((reference) => reference.type.includes("_video"));

    if (videoCallReference) {
      evt.videoCallData = {
        type: videoCallReference.type,
        id: videoCallReference.meetingId,
        password: videoCallReference?.meetingPassword,
        url: videoCallReference.meetingUrl,
      };
    }
  };

  /* Check if the original booking has no more attendees, if so delete the booking
  and any calendar or video integrations */
  const lastAttendeeDeleteBooking = async (
    originalRescheduledBooking: Awaited<ReturnType<typeof getOriginalRescheduledBooking>>,
    filteredAttendees: Partial<Attendee>[],
    originalBookingEvt?: CalendarEvent
  ) => {
    let deletedReferences = false;
    if (filteredAttendees && filteredAttendees.length === 0 && originalRescheduledBooking) {
      const integrationsToDelete = [];

      for (const reference of originalRescheduledBooking.references) {
        if (reference.credentialId) {
          const credential = await prisma.credential.findUnique({
            where: {
              id: reference.credentialId,
            },
            select: credentialForCalendarServiceSelect,
          });

          if (credential) {
            if (reference.type.includes("_video")) {
              integrationsToDelete.push(deleteMeeting(credential, reference.uid));
            }
            if (reference.type.includes("_calendar") && originalBookingEvt) {
              const calendar = await getCalendar(credential);
              if (calendar) {
                integrationsToDelete.push(
                  calendar?.deleteEvent(reference.uid, originalBookingEvt, reference.externalCalendarId)
                );
              }
            }
          }
        }
      }

      await Promise.all(integrationsToDelete).then(async () => {
        await prisma.booking.update({
          where: {
            id: originalRescheduledBooking.id,
          },
          data: {
            status: BookingStatus.CANCELLED,
          },
        });
      });
      deletedReferences = true;
    }
    return deletedReferences;
  };

  // data needed for triggering webhooks
  const eventTypeInfo: EventTypeInfo = {
    eventTitle: eventType.title,
    eventDescription: eventType.description,
    requiresConfirmation: requiresConfirmation || null,
    price: paymentAppData.price,
    currency: eventType.currency,
    length: eventType.length,
  };

  const teamId = await getTeamIdFromEventType({ eventType });

  const triggerForUser = !teamId || (teamId && eventType.parentId);

  const subscriberOptions: GetSubscriberOptions = {
    userId: triggerForUser ? organizerUser.id : null,
    eventTypeId,
    triggerEvent: WebhookTriggerEvents.BOOKING_CREATED,
    teamId,
  };

  const eventTrigger: WebhookTriggerEvents = rescheduleUid
    ? WebhookTriggerEvents.BOOKING_RESCHEDULED
    : WebhookTriggerEvents.BOOKING_CREATED;

  subscriberOptions.triggerEvent = eventTrigger;

  const subscriberOptionsMeetingEnded = {
    userId: triggerForUser ? organizerUser.id : null,
    eventTypeId,
    triggerEvent: WebhookTriggerEvents.MEETING_ENDED,
    teamId,
  };

  const isKYCVerified = isEventTypeOwnerKYCVerified(eventType);

  if (reqBody.recurringEventId && eventType.recurringEvent) {
    // Overriding the recurring event configuration count to be the actual number of events booked for
    // the recurring event (equal or less than recurring event configuration count)
    eventType.recurringEvent = Object.assign({}, eventType.recurringEvent, { count: recurringCount });
    evt.recurringEvent = eventType.recurringEvent;
  }

  // If the user is not the owner of the event, new booking should be always pending.
  // Otherwise, an owner rescheduling should be always accepted.
  // Before comparing make sure that userId is set, otherwise undefined === undefined
  const userReschedulingIsOwner = userId && originalRescheduledBooking?.user?.id === userId;
  const isConfirmedByDefault = (!requiresConfirmation && !paymentAppData.price) || userReschedulingIsOwner;

  async function createBooking() {
    if (originalRescheduledBooking) {
      evt.title = originalRescheduledBooking?.title || evt.title;
      evt.description = originalRescheduledBooking?.description || evt.description;
      evt.location = originalRescheduledBooking?.location || evt.location;
    }

    const eventTypeRel = !eventTypeId
      ? {}
      : {
          connect: {
            id: eventTypeId,
          },
        };

    const dynamicEventSlugRef = !eventTypeId ? eventTypeSlug : null;
    const dynamicGroupSlugRef = !eventTypeId ? (reqBody.user as string).toLowerCase() : null;

    const isConfirmedByDefault = !!originalRescheduledBooking;

    const attendeesData = evt.attendees.map((attendee) => {
      //if attendee is team member, it should fetch their locale not booker's locale
      //perhaps make email fetch request to see if his locale is stored, else
      return {
        name: attendee.name,
        email: attendee.email,
        timeZone: attendee.timeZone,
        locale: attendee.language.locale,
      };
    });

    if (evt.team?.members) {
      attendeesData.push(
        ...evt.team.members.map((member) => ({
          email: member.email,
          name: member.name,
          timeZone: member.timeZone,
          locale: member.language.locale,
        }))
      );
    }

    const newBookingData: Prisma.BookingCreateInput = {
      uid,
      responses: responses === null ? Prisma.JsonNull : responses,
      title: evt.title,
      startTime: dayjs.utc(evt.startTime).toDate(),
      endTime: dayjs.utc(evt.endTime).toDate(),
      description: evt.additionalNotes,
      customInputs: isPrismaObjOrUndefined(evt.customInputs),
      status: isConfirmedByDefault ? BookingStatus.ACCEPTED : BookingStatus.PENDING,
      location: evt.location,
      eventType: eventTypeRel,
      smsReminderNumber,
      metadata: reqBody.metadata,
      attendees: {
        createMany: {
          data: attendeesData,
        },
      },
      dynamicEventSlugRef,
      dynamicGroupSlugRef,
      user: {
        connect: {
          id: organizerUser.id,
        },
      },
      destinationCalendar:
        evt.destinationCalendar && evt.destinationCalendar.length > 0
          ? {
              connect: { id: evt.destinationCalendar[0].id },
            }
          : undefined,
    };

    if (reqBody.recurringEventId) {
      newBookingData.recurringEventId = reqBody.recurringEventId;
    }
    if (originalRescheduledBooking) {
      newBookingData.metadata = {
        ...(typeof originalRescheduledBooking.metadata === "object" && originalRescheduledBooking.metadata),
      };
      newBookingData["paid"] = originalRescheduledBooking.paid;
      newBookingData["fromReschedule"] = originalRescheduledBooking.uid;
      if (originalRescheduledBooking.uid) {
        newBookingData.cancellationReason = rescheduleReason;
      }
      if (newBookingData.attendees?.createMany?.data) {
        // Reschedule logic with booking with seats
        if (eventType?.seatsPerTimeSlot && bookerEmail) {
          newBookingData.attendees.createMany.data = attendeesData.filter(
            (attendee) => attendee.email === bookerEmail
          );
        }
      }
      if (originalRescheduledBooking.recurringEventId) {
        newBookingData.recurringEventId = originalRescheduledBooking.recurringEventId;
      }
    }
    const createBookingObj = {
      include: {
        user: {
          select: { email: true, name: true, timeZone: true, username: true },
        },
        attendees: true,
        payment: true,
        references: true,
      },
      data: newBookingData,
    };

    if (originalRescheduledBooking?.paid && originalRescheduledBooking?.payment) {
      const bookingPayment = originalRescheduledBooking?.payment?.find((payment) => payment.success);

      if (bookingPayment) {
        createBookingObj.data.payment = {
          connect: { id: bookingPayment.id },
        };
      }
    }

    if (typeof paymentAppData.price === "number" && paymentAppData.price > 0) {
      /* Validate if there is any payment app credential for this user */
      await prisma.credential.findFirstOrThrow({
        where: {
          appId: paymentAppData.appId,
          ...(paymentAppData.credentialId
            ? { id: paymentAppData.credentialId }
            : { userId: organizerUser.id }),
        },
        select: {
          id: true,
        },
      });
    }

    return prisma.booking.create(createBookingObj);
  }

  let results: EventResult<AdditionalInformation & { url?: string; iCalUID?: string }>[] = [];
  let referencesToCreate: PartialReference[] = [];

  type Booking = Prisma.PromiseReturnType<typeof createBooking>;
  let booking: (Booking & { appsStatus?: AppsStatus[] }) | null = null;
  try {
    booking = await createBooking();

    // @NOTE: Add specific try catch for all subsequent async calls to avoid error
    // Sync Services
    await syncServicesUpdateWebUser(
      await prisma.user.findFirst({
        where: { id: userId },
        select: { id: true, email: true, name: true, username: true, createdDate: true },
      })
    );
    evt.uid = booking?.uid ?? null;

    if (booking && booking.id && eventType.seatsPerTimeSlot) {
      const currentAttendee = booking.attendees.find(
        (attendee) => attendee.email === req.body.responses.email
      );

      // Save description to bookingSeat
      const uniqueAttendeeId = uuid();
      await prisma.bookingSeat.create({
        data: {
          referenceUid: uniqueAttendeeId,
          data: {
            description: evt.additionalNotes,
          },
          booking: {
            connect: {
              id: booking.id,
            },
          },
          attendee: {
            connect: {
              id: currentAttendee?.id,
            },
          },
        },
      });
      evt.attendeeSeatId = uniqueAttendeeId;
    }
  } catch (_err) {
    const err = getErrorFromUnknown(_err);
    log.error(`Booking ${eventTypeId} failed`, "Error when saving booking to db", err.message);
    if (err.code === "P2002") {
      throw new HttpError({ statusCode: 409, message: "booking.conflict" });
    }
    throw err;
  }

  // After polling videoBusyTimes, credentials might have been changed due to refreshment, so query them again.
  const credentials = await refreshCredentials(allCredentials);
  const eventManager = new EventManager({ ...organizerUser, credentials });

  function handleAppsStatus(
    results: EventResult<AdditionalInformation>[],
    booking: (Booking & { appsStatus?: AppsStatus[] }) | null
  ) {
    // Taking care of apps status
    const resultStatus: AppsStatus[] = results.map((app) => ({
      appName: app.appName,
      type: app.type,
      success: app.success ? 1 : 0,
      failures: !app.success ? 1 : 0,
      errors: app.calError ? [app.calError] : [],
      warnings: app.calWarnings,
    }));

    if (reqAppsStatus === undefined) {
      if (booking !== null) {
        booking.appsStatus = resultStatus;
      }
      evt.appsStatus = resultStatus;
      return;
    }
    // From down here we can assume reqAppsStatus is not undefined anymore
    // Other status exist, so this is the last booking of a series,
    // proceeding to prepare the info for the event
    const calcAppsStatus = reqAppsStatus.concat(resultStatus).reduce((prev, curr) => {
      if (prev[curr.type]) {
        prev[curr.type].success += curr.success;
        prev[curr.type].errors = prev[curr.type].errors.concat(curr.errors);
        prev[curr.type].warnings = prev[curr.type].warnings?.concat(curr.warnings || []);
      } else {
        prev[curr.type] = curr;
      }
      return prev;
    }, {} as { [key: string]: AppsStatus });
    evt.appsStatus = Object.values(calcAppsStatus);
  }

  let videoCallUrl;
  if (originalRescheduledBooking?.uid) {
    try {
      // cancel workflow reminders from previous rescheduled booking
      await cancelWorkflowReminders(originalRescheduledBooking.workflowReminders);
    } catch (error) {
      log.error("Error while canceling scheduled workflow reminders", error);
    }

    // Use EventManager to conditionally use all needed integrations.
    addVideoCallDataToEvt(originalRescheduledBooking.references);
    const updateManager = await eventManager.reschedule(evt, originalRescheduledBooking.uid);

    //update original rescheduled booking (no seats event)
    if (!eventType.seatsPerTimeSlot) {
      await prisma.booking.update({
        where: {
          id: originalRescheduledBooking.id,
        },
        data: {
          status: BookingStatus.CANCELLED,
        },
      });
    }

    // This gets overridden when updating the event - to check if notes have been hidden or not. We just reset this back
    // to the default description when we are sending the emails.
    evt.description = eventType.description;

    results = updateManager.results;
    referencesToCreate = updateManager.referencesToCreate;
    if (results.length > 0 && results.some((res) => !res.success)) {
      const error = {
        errorCode: "BookingReschedulingMeetingFailed",
        message: "Booking Rescheduling failed",
      };

      log.error(`Booking ${organizerUser.name} failed`, error, results);
    } else {
      const metadata: AdditionalInformation = {};
      const calendarResult = results.find((result) => result.type.includes("_calendar"));

      evt.iCalUID = Array.isArray(calendarResult?.updatedEvent)
        ? calendarResult?.updatedEvent[0]?.iCalUID
        : calendarResult?.updatedEvent?.iCalUID || undefined;

      if (results.length) {
        // TODO: Handle created event metadata more elegantly
        const [updatedEvent] = Array.isArray(results[0].updatedEvent)
          ? results[0].updatedEvent
          : [results[0].updatedEvent];
        if (updatedEvent) {
          metadata.hangoutLink = updatedEvent.hangoutLink;
          metadata.conferenceData = updatedEvent.conferenceData;
          metadata.entryPoints = updatedEvent.entryPoints;
          handleAppsStatus(results, booking);
          videoCallUrl = metadata.hangoutLink || videoCallUrl || updatedEvent?.url;
        }
      }
      if (noEmail !== true && (!requiresConfirmation || isOrganizerRescheduling)) {
        const copyEvent = cloneDeep(evt);
        await sendRescheduledEmails({
          ...copyEvent,
          additionalInformation: metadata,
          additionalNotes, // Resets back to the additionalNote input and not the override value
          cancellationReason: "$RCH$" + (rescheduleReason ? rescheduleReason : ""), // Removable code prefix to differentiate cancellation from rescheduling for email
        });
      }
    }
  }

  req.statusCode = 201;
  return { ...booking, paymentRequired: !rescheduleUid };
}

export default handler;

function handleCustomInputs(
  eventTypeCustomInputs: EventTypeCustomInput[],
  reqCustomInputs: {
    value: string | boolean;
    label: string;
  }[]
) {
  eventTypeCustomInputs.forEach((etcInput) => {
    if (etcInput.required) {
      const input = reqCustomInputs.find((i) => i.label === etcInput.label);
      if (etcInput.type === "BOOL") {
        z.literal(true, {
          errorMap: () => ({ message: `Missing ${etcInput.type} customInput: '${etcInput.label}'` }),
        }).parse(input?.value);
      } else if (etcInput.type === "PHONE") {
        z.string({
          errorMap: () => ({
            message: `Missing ${etcInput.type} customInput: '${etcInput.label}'`,
          }),
        })
          .refine((val) => isValidPhoneNumber(val), {
            message: "Phone number is invalid",
          })
          .parse(input?.value);
      } else {
        // type: NUMBER are also passed as string
        z.string({
          errorMap: () => ({ message: `Missing ${etcInput.type} customInput: '${etcInput.label}'` }),
        })
          .min(1)
          .parse(input?.value);
      }
    }
  });
}

const findBookingQuery = async (bookingId: number) => {
  const foundBooking = await prisma.booking.findUnique({
    where: {
      id: bookingId,
    },
    select: {
      uid: true,
      location: true,
      startTime: true,
      endTime: true,
      title: true,
      description: true,
      status: true,
      responses: true,
      user: {
        select: {
          name: true,
          email: true,
          timeZone: true,
          username: true,
        },
      },
      eventType: {
        select: {
          title: true,
          description: true,
          currency: true,
          length: true,
          requiresConfirmation: true,
          requiresBookerEmailVerification: true,
          price: true,
        },
      },
    },
  });

  // This should never happen but it's just typescript safe
  if (!foundBooking) {
    throw new Error("Internal Error.");
  }

  // Don't leak any sensitive data
  return foundBooking;
};
