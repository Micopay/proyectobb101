export declare function resolveErrorMessage(error: unknown): {
  key: string;
  title: string;
  message: string;
  action: string;
  fundsSafe: boolean;
};

export declare const statusToKey: Record<number, string>;
export declare const domainToKey: Record<string, string>;
