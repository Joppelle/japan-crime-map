export const CATEGORY_META = {
  snatching: { ja: "ひったくり", en: "Snatching", color: "#e4572e" },
  vehicle_break_in: { ja: "車上ねらい", en: "Vehicle break-in", color: "#f3a712" },
  parts_theft: { ja: "部品ねらい", en: "Parts theft", color: "#f7d002" },
  vending_machine_theft: { ja: "自動販売機ねらい", en: "Vending machine", color: "#7cb518" },
  car_theft: { ja: "自動車盗", en: "Car theft", color: "#2e933c" },
  motorcycle_theft: { ja: "オートバイ盗", en: "Motorcycle theft", color: "#2978a0" },
  bicycle_theft: { ja: "自転車盗", en: "Bicycle theft", color: "#6a4c93" },
} as const;

export type CrimeCategory = keyof typeof CATEGORY_META;

export type Incident = {
  id: string;
  category: CrimeCategory;
  date: string;
  hour: number | null;
  prefecture: string;
  municipality: string;
  town: string | null;
  policeStation: string | null;
  place: string | null;
  longitude: number;
  latitude: number;
  geocodeLevel: "chome" | "municipality";
  geocodeConfidence: "high" | "low";
  sourceUrl: string;
  sourceFile: string;
  reportingYear: number;
};

export type IncidentDataset = {
  metadata: {
    generatedAt: string;
    reportingYear: number;
    sourceName: string;
    sourceUrl: string;
    addressSource: string;
    publishedRecords: number;
    rawRecords: number;
    isSample: boolean;
    sampleLimitPerCategory: number | null;
    privacyThreshold: number;
    sources: {
      category: CrimeCategory;
      resourceUrl: string;
      fileName: string;
      sha256: string;
      encoding: string;
      format: string;
      rows: number;
    }[];
  };
  incidents: Incident[];
};
