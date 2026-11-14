// Transaction vocabulary shared by every data source. Pure, no I/O.
// Maps S-Pankki dataset rows (category, transaction_type, MCC) to display labels
// and to the coach keys the scenarios talk about (taxi, food_delivery, leisure...).

// Merchant labels by MCC code (ISO 18245). The dataset has merchant ids, not names.
export const MCC_LABEL: Record<string, string> = {
  5411: 'Grocery store', 5422: 'Butcher', 5451: 'Dairy shop', 5499: 'Food shop',
  5812: 'Restaurant', 5813: 'Bar', 5814: 'Fast food and delivery',
  4111: 'Public transport', 4121: 'Taxi', 5541: 'Fuel station', 5542: 'Fuel station', 7523: 'Parking',
  7832: 'Cinema', 7922: 'Theatre and events', 7941: 'Sports club', 7991: 'Attraction', 7996: 'Amusement park', 7999: 'Leisure',
  5912: 'Pharmacy', 8011: 'Doctor', 8099: 'Health service',
  5200: 'Home supplies', 5251: 'Hardware store', 5712: 'Furniture', 5732: 'Electronics',
  5651: 'Clothing', 5691: 'Clothing', 5941: 'Sports shop', 5999: 'Shop',
  4511: 'Airline', 4722: 'Travel agency', 7011: 'Hotel'
};

export const TYPE_LABEL: Record<string, string> = {
  salary: 'Salary', housing_payment: 'Housing payment', utilities_payment: 'Utilities',
  investment_deposit: 'Investment deposit', investment_withdrawal: 'Investment withdrawal'
};

// Coach keys used by the scenarios and facts.
export const COACH_KEY_BY_MCC: Record<string, string> = {
  4121: 'taxi', 5814: 'food_delivery',
  7832: 'leisure', 7922: 'leisure', 7941: 'leisure', 7991: 'leisure', 7996: 'leisure', 7999: 'leisure',
  5411: 'groceries', 5422: 'groceries', 5451: 'groceries', 5499: 'groceries'
};

// Fixture vocabulary (hand-made demo data uses snake_case categories).
export const FIXTURE_LABEL: Record<string, string> = {
  food_delivery: 'Food delivery', groceries: 'Groceries', taxi: 'Taxi', leisure: 'Leisure',
  housing: 'Housing', loan: 'Mortgage', fitness: 'Fitness', subscriptions: 'Subscriptions',
  transport: 'Transport', fuel: 'Fuel', salary: 'Salary', utilities: 'Utilities',
  restaurants: 'Restaurants', phone: 'Phone', insurance: 'Insurance', health: 'Health',
  repairs: 'Repairs', services: 'Services', transfer: 'Transfer'
};

interface Row { mcc?: string | null; type?: string; category?: string }

export function merchantLabel({ mcc, type, category }: Row): string {
  return (mcc && MCC_LABEL[mcc]) || (type && TYPE_LABEL[type]) || category || 'Transaction';
}

export function coachKey({ mcc, type, category }: Row): string {
  if (mcc && COACH_KEY_BY_MCC[mcc]) return COACH_KEY_BY_MCC[mcc];
  if (type === 'housing_payment') return 'housing';
  return String(category || 'other').toLowerCase().replace(/[^a-z]+/g, '_');
}

