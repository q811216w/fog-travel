// 背景定位任務必須在最外層、最先定義，app 在背景被系統喚醒時才找得到它
import './src/background';

import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
