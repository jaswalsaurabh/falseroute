import { SCENARIO_CATALOG, type IntrusionEvent, type ScenarioKind } from '@false-route/contracts';

function formatEventType(eventType: string): string {
  return eventType
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

export function scenarioLabel(scenarioKind: ScenarioKind | undefined): string | undefined {
  return scenarioKind ? SCENARIO_CATALOG[scenarioKind]?.title : undefined;
}

export function eventLabel(event: Pick<IntrusionEvent, 'eventType' | 'scenarioKind'>): string {
  return scenarioLabel(event.scenarioKind) ?? formatEventType(event.eventType);
}
