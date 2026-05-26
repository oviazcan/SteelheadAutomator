const calculateNewSchedule = (inputs: Inputs, helpers: Helpers): Inputs => {
  // Accounts we want to prioritize
  const priorityAccountIds = [1, 5];

  helpers.log("Starting schedule prioritization for accounts " + priorityAccountIds.join(", "));

  // Split tasks into unscheduled vs others.
  const unscheduledTasks = inputs.tasks.filter(t => t.status === "UNSCHEDULED");
  const otherTasks = inputs.tasks.filter(t => t.status !== "UNSCHEDULED");

  // Find high-priority unscheduled tasks
  const highPriorityUnscheduled = unscheduledTasks.filter(task => {
    if ("scheduleTaskElementsByScheduleTaskId" in task) {
      return task.scheduleTaskElementsByScheduleTaskId.some(element =>
        element.relatedPartLocations.some(loc => priorityAccountIds.includes(loc.accountId))
      );
    }
    return false;
  });

  // Everything else stays as normal
  const normalUnscheduled = unscheduledTasks.filter(task => !highPriorityUnscheduled.includes(task));

  // Sort: priority unscheduled first, then the rest
  const reorderedUnscheduled = [...highPriorityUnscheduled, ...normalUnscheduled];

  // Optionally reassign expectedStartTime so priority tasks actually jump the queue
  let currentTime = new Date();
  const assignTimes = (taskList: typeof inputs.tasks) => {
    return taskList.map(task => {
      if ("expectedStartTime" in task && task.status === "UNSCHEDULED") {
        const updatedTask = { ...task, expectedStartTime: new Date(currentTime) };
        const duration =
          ("cycleTimeMinutes" in task && task.cycleTimeMinutes) ||
          ("expectedDurationMinutes" in task && task.expectedDurationMinutes) ||
          0;
        currentTime = new Date(currentTime.getTime() + duration * 60 * 1000);
        return updatedTask;
      }
      return task;
    });
  };

  const finalUnscheduled = assignTimes(reorderedUnscheduled);

  helpers.log({
    highPriorityAccountIds: priorityAccountIds,
    prioritizedTaskIds: highPriorityUnscheduled.map(t => t.id),
    otherUnscheduledTaskIds: normalUnscheduled.map(t => t.id),
    otherTaskIds: otherTasks.map(t => t.id),
  });

  // Final order: prioritized unscheduled first, then others
  return {
    ...inputs,
    tasks: [...finalUnscheduled, ...otherTasks],
  };
};


interface Inputs {
  tasks: ({
    id: number;
    stationId: number | null;
    cycleTimeMinutes: number | null;
    totalTimeMinutes: number | null;
    treatmentTimeMinutes: number | null;
    stationTaskAdditionalTimeMinutes: number | null;
    expectedStartTime: Date | null;
    isIntentional: boolean;
    treatmentIds: number[];
    scheduleTaskElementsByScheduleTaskId: {
      id: number | null;
      partCount: number;
      partsPerBatch: number;
      recipeNodeId: number;
      partNumberId: number;
      relatedPartLocations: {
        accountId: number;
        partNumberId: number | null;
        workOrderId: number | null;
        partGroupId: number | null;
        partCount: number;
        partsTransferAccountByAccountId: {
          associatedScheduleTaskElements: {
            nodes: {
              id: number;
              scheduleTaskId: number;
            }[];
          } | null;
        } | null;
      }[];
    }[];
    status: "COMPLETED" | "INVALID" | "PAUSED" | "QUEUED" | "RUNNING" | "UNSCHEDULED";
  } | {
    id: number | null;
    stationTaskTypeId: number;
    stationTaskTypeByStationTaskTypeId: {
      name: string | null;
    } | null;
    stationByStationId: {
      id: number;
    } | null;
    stationId: number;
    expectedDurationMinutes: number | null;
    expectedStartTime: Date | null;
    rrule: string | null;
    blockingTreatments: boolean;
    isIntentional: boolean;
    status: "COMPLETED" | "INVALID" | "PAUSED" | "QUEUED" | "RUNNING" | "UNSCHEDULED";
  })[];
}

type Severity = 'warning' | 'error' | 'info' | 'success'
type ErrorMessage = string | { severity: Severity, message: string }

interface Helpers {
  log: (message: any) => void
  addErrorMessage: (message: ErrorMessage) => void
  addInformationalPrice: (value: { title: string, note?: string, price: number, category?: string }) => void
  addQuotePartPricingTier: (value: { title: string, quantity: number, price: number }) => void
  parseCSV: (value: string) => { data: any[][], errors: [], meta: any }
}