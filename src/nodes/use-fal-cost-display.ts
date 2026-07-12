import { useEffect, useState } from "react";
import {
  loadFalEmpiricalCost,
  type FalCostContext,
  type FalCostDisplayEstimate,
  type FalCostEstimate,
} from "./fal-pricing";

/** Official pricing always wins. Local actual history is queried only when the
 * official estimator deliberately fails closed for the exact configuration. */
export function useFalCostDisplay(
  official: FalCostEstimate,
  endpoint: string | undefined,
  schemaHash: string | undefined,
  context: FalCostContext | undefined,
): FalCostDisplayEstimate {
  const [display, setDisplay] = useState<FalCostDisplayEstimate>(official);
  const contextKey = context ? JSON.stringify(context) : "";
  useEffect(() => {
    let current = true;
    setDisplay(official);
    if (official.state === "available" || !endpoint || !schemaHash || !context)
      return () => { current = false; };
    void loadFalEmpiricalCost(endpoint, schemaHash, context).then((estimate) => {
      if (current && estimate) setDisplay(estimate);
    });
    return () => { current = false; };
  }, [official.state, official.state === "available" ? official.amountMicrounits : official.reason, endpoint, schemaHash, contextKey]);
  return display;
}
