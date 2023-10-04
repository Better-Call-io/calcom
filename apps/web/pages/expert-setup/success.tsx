import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Check } from "@calcom/ui/components/icon";

import PageWrapper from "@components/PageWrapper";

const SuccessExpertSetupPage = () => {
  const { t } = useLocale();
  return (
    <div className="flex min-h-screen flex-col justify-center bg-[#f3f4f6] py-12 sm:px-6 lg:px-8">
      <div className="mb-auto mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-default border-subtle mx-2 rounded-md border px-4 py-10 sm:px-10">
          <div className="mb-4">
            <div className="bg-success mx-auto flex h-12 w-12 items-center justify-center rounded-full">
              <Check className="h-6 w-6 text-green-600" />
            </div>
            <div className="mt-3 text-center sm:mt-5">
              <h3 className="text-emphasis text-lg font-medium leading-6" id="modal-title">
                {t("your_user_profile_updated_successfully")}
              </h3>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
SuccessExpertSetupPage.PageWrapper = PageWrapper;
export default SuccessExpertSetupPage;
