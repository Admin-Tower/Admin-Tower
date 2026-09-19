import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { NavigationComponent } from './navigation/navigation.component';

@Component({
  imports: [RouterModule, NavigationComponent],
  selector: 'tower-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
