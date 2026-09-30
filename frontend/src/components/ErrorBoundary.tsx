import { Component } from "react";
import type { ReactNode } from "react";

type Props = { children: ReactNode; resetKey?: string };

/** Упавший экран не должен уносить всё приложение.
 *
 *  Без этого одна ошибка отрисовки (в редакторе кадра она случалась) давала
 *  пустую белую страницу: ни навигации, ни способа уйти. Теперь падает только
 *  содержимое, оболочка остаётся, а на смену адреса экран пробует заново.
 *  Сброс по `resetKey`, а не по `key`: ключ пересоздавал бы весь проект с его
 *  живой связью на каждой смене вкладки. */
export default class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("экран упал:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mag-content">
        <div className="mag-error" role="alert">
          Экран упал: {this.state.error.message}
        </div>
        <button className="mag-ghost mag-ghost-inline" onClick={() => this.setState({ error: null })}>
          Попробовать снова
        </button>
      </div>
    );
  }
}
