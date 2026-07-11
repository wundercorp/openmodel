const compactNumberUnits = [
  { threshold: 1_000_000_000_000, suffix: "t" },
  { threshold: 1_000_000_000, suffix: "b" },
  { threshold: 1_000_000, suffix: "m" },
  { threshold: 1_000, suffix: "k" },
] as const;

export function finiteNumber(value: unknown) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

export function formatCompactNumber(value: unknown, maximumFractionDigits = 1) {
  const numericValue = finiteNumber(value);
  const absoluteValue = Math.abs(numericValue);
  let selectedUnitIndex = compactNumberUnits.findIndex(
    (unit) => absoluteValue >= unit.threshold,
  );

  if (selectedUnitIndex < 0) {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits,
    }).format(numericValue);
  }

  let selectedUnit = compactNumberUnits[selectedUnitIndex];
  let scaledValue = numericValue / selectedUnit.threshold;
  const roundedScaledValue = Number(scaledValue.toFixed(maximumFractionDigits));

  if (Math.abs(roundedScaledValue) >= 1_000 && selectedUnitIndex > 0) {
    selectedUnitIndex -= 1;
    selectedUnit = compactNumberUnits[selectedUnitIndex];
    scaledValue = numericValue / selectedUnit.threshold;
  }

  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
  }).format(scaledValue)}${selectedUnit.suffix}`;
}

export function formatExactInteger(value: unknown) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(finiteNumber(value));
}
