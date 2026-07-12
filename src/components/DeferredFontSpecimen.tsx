import { RecoverableLazy } from "./RecoverableLazy";
import type { ComponentProps } from "react";
import type { FontSpecimenPreview } from "./FontSpecimenPreview";

const loadFontSpecimen = () =>
  import("./FontSpecimenPreview").then((module) => ({
    default: module.FontSpecimenPreview,
  }));

type Props = ComponentProps<typeof FontSpecimenPreview>;

export function DeferredFontSpecimen(props: Props) {
  return (
    <RecoverableLazy
      loader={loadFontSpecimen}
      componentProps={props}
      loading={<div className="font-specimen-loading" role="status" />}
    />
  );
}
