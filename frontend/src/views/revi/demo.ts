import { useData } from '../../models/hooks';
import { isError } from '../../models/phoneModel';

export const CAR_QUESTION = 'Could I buy a used Toyota Yaris Hybrid for €8,000 in 12 months?';
export const SPENDING_QUESTION = 'Where did my money go?';
export const WEEKLY_QUESTION = 'What can I safely spend this week?';

export function useTrainerStatus(enabled = true) {
  const status = useData<{ research: boolean; data: string }>(enabled ? '/api/trainer/status' : null);
  return status && !isError(status) ? status : undefined;
}

export const demoDataLabel = (source?: string) =>
  source === 'csv' ? 'S-Pankki synthetic data' : source === 'fixture' ? 'Illustrative demo data' : 'Banking prototype';
