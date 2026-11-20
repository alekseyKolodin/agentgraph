// Разделы редактора рутины (Editor.dc.html): «Когда · Что сделать · Как узнаю» и проверка на истории. Правят только
// черновик (RoutineDraft) через set — из них же собирается «Новая рутина».
export { Section, MenuButton, LeaveProvider, useLeave, useLeaveGuard, leaveClick, useRoutineSource, type DraftProps, type FilledProp, type Leave, type MenuItem, type RoutineSource } from './Section';
export { WhenSection, SourcePicks, SourceCard, ScheduleCard, ConditionsCard, CondRow, AiCard } from './WhenSection';
export { WhatSection, FlowField, RunModeField, Extras, type FlowExtras } from './WhatSection';
export { NotifySection, HomeRow, ReplyRow, TaskSettings } from './NotifySection';
export { HistoryPanel, historyCacheKey } from './HistoryPanel';
