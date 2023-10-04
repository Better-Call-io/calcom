import type { GetServerSidePropsContext } from "next";
import { serverSideTranslations } from "next-i18next/serverSideTranslations";
import Head from "next/head";
import { usePathname, useRouter } from "next/navigation";
import type { CSSProperties } from "react";
import { Suspense } from "react";
import { z } from "zod";

import { getServerSession } from "@calcom/feature-auth/lib/getServerSession";
import { APP_NAME } from "@calcom/lib/constants";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { useParamsWithFallback } from "@calcom/lib/hooks/useParamsWithFallback";
import prisma from "@calcom/prisma";
import { trpc } from "@calcom/trpc";
import { Button, StepCard, Steps } from "@calcom/ui";
import { Loader } from "@calcom/ui/components/icon";

import PageWrapper from "@components/PageWrapper";
import { ConnectedCalendars } from "@components/getting-started/steps-views/ConnectCalendars";
import { SetupAvailability } from "@components/getting-started/steps-views/SetupAvailability";

import { ssrInit } from "@server/lib/ssr";

const INITIAL_STEP = "connected-calendar";
const steps = ["connected-calendar", "setup-availability"] as const;

const stepTransform = (step: (typeof steps)[number]) => {
  const stepIndex = steps.indexOf(step);
  if (stepIndex > -1) {
    return steps[stepIndex];
  }
  return INITIAL_STEP;
};

const stepRouteSchema = z.object({
  step: z.array(z.enum(steps)).default([INITIAL_STEP]),
  from: z.string().optional(),
});

const ExpertSetupPage = () => {
  const params = useParamsWithFallback();
  const pathname = usePathname();
  const router = useRouter();
  const [user] = trpc.viewer.me.useSuspenseQuery();
  const { t } = useLocale();
  const result = stepRouteSchema.safeParse(params);
  const currentStep = result.success ? result.data.step[0] : INITIAL_STEP;

  const headers = [
    {
      title: `${t("connect_your_calendar")}`,
      subtitle: [`${t("connect_your_calendar_instructions")}`],
      skipText: `${t("connect_calendar_later")}`,
    },
    {
      title: `${t("set_availability")}`,
      subtitle: [
        `${t("set_availability_getting_started_subtitle_1")}`,
        `${t("set_availability_getting_started_subtitle_2")}`,
      ],
    },
  ];

  const goToIndex = (index: number) => {
    const newStep = steps[index];
    router.push(`/expert-setup/${stepTransform(newStep)}`);
  };

  const currentStepIndex = steps.indexOf(currentStep);

  return (
    <div
      className="dark:bg-brand dark:text-brand-contrast text-emphasis min-h-screen"
      data-testid="onboarding"
      style={
        {
          "--cal-brand": "#111827",
          "--cal-brand-emphasis": "#101010",
          "--cal-brand-text": "white",
          "--cal-brand-subtle": "#9CA3AF",
        } as CSSProperties
      }
      key={pathname}>
      <Head>
        <title>{`${APP_NAME} - ${t("getting_started")}`}</title>
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <div className="mx-auto py-6 sm:px-4 md:py-24">
        <div className="relative">
          <div className="sm:mx-auto sm:w-full sm:max-w-[600px]">
            <div className="mx-auto px-4 sm:max-w-[520px]">
              <header>
                <p className="font-cal mb-3 text-[28px] font-medium leading-7">
                  {headers[currentStepIndex]?.title || "Undefined title"}
                </p>

                {headers[currentStepIndex]?.subtitle.map((subtitle, index) => (
                  <p className="text-subtle font-sans text-sm font-normal" key={index}>
                    {subtitle}
                  </p>
                ))}
              </header>
              <Steps maxSteps={steps.length} currentStep={currentStepIndex + 1} navigateToStep={goToIndex} />
            </div>
            <StepCard>
              <Suspense fallback={<Loader />}>
                {currentStep === "connected-calendar" && <ConnectedCalendars nextStep={() => goToIndex(1)} />}

                {currentStep === "setup-availability" && (
                  <SetupAvailability
                    nextStep={() => goToIndex(2)}
                    defaultScheduleId={user.defaultScheduleId}
                    isFinalStep={true}
                  />
                )}
              </Suspense>
            </StepCard>

            {headers[currentStepIndex]?.skipText && (
              <div className="flex w-full flex-row justify-center">
                <Button
                  color="minimal"
                  data-testid="skip-step"
                  onClick={(event) => {
                    event.preventDefault();
                    goToIndex(currentStepIndex + 1);
                  }}
                  className="mt-8 cursor-pointer px-4 py-2 font-sans text-sm font-medium">
                  {headers[currentStepIndex]?.skipText}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export const getServerSideProps = async (context: GetServerSidePropsContext) => {
  const { req, res } = context;

  const session = await getServerSession({ req, res });

  if (!session?.user?.id) {
    return { redirect: { permanent: false, destination: "/auth/login?callbackUrl=/expert-setup" } };
  }

  const ssr = await ssrInit(context);

  await ssr.viewer.me.prefetch();

  const user = await prisma.user.findUnique({
    where: {
      id: session.user.id,
    },
  });

  if (!user) {
    throw new Error("User from session not found");
  }

  return {
    props: {
      ...(await serverSideTranslations(context.locale ?? "", ["common"])),
      trpcState: ssr.dehydrate(),
    },
  };
};

ExpertSetupPage.isThemeSupported = false;
ExpertSetupPage.PageWrapper = PageWrapper;

export default ExpertSetupPage;
