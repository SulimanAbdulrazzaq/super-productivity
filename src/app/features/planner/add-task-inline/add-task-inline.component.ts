import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { T } from 'src/app/t.const';
import {
  AddTaskBarComponent,
  TaskAddEvent,
} from '../../tasks/add-task-bar/add-task-bar.component';
import { MatIcon } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { MatButton } from '@angular/material/button';
import { TaskCopy } from '../../tasks/task.model';

@Component({
  selector: 'add-task-inline',
  imports: [AddTaskBarComponent, MatIcon, TranslatePipe, MatButton],
  templateUrl: './add-task-inline.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
})
export class AddTaskInlineComponent {
  T: typeof T = T;

  readonly planForDay = input<string>();
  readonly additionalFields = input<Partial<TaskCopy>>();
  readonly tagsToRemove = input<string[]>([]);
  readonly taskIdsToExclude = input<string[]>();
  readonly isNoDefaults = input<boolean>(false);
  readonly afterTaskAdd = output<TaskAddEvent>();

  isShowAddTask = false;
}

/**
 * The collapsed add button, which keyboard focus recovery falls back to after a
 * bulk action empties a list. Deliberately NOT just `add-task-inline button`:
 * once the inline form is expanded, that also matches buttons inside the
 * add-task-bar which replaces this one. Pinned by add-task-inline.component.spec.ts.
 */
export const ADD_TASK_INLINE_BTN_SELECTOR = 'add-task-inline [data-add-task-btn]';
