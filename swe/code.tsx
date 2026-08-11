import { Component } from "react";
import { codeToTokens, type ThemedToken } from "shiki";

interface CodeProps {

  code: string;
  lang?: string;

  /** Highlighting is skipped while a command is still streaming; the plain text is shown until it settles. */
  streaming?: boolean;

}

interface CodeState {

  lines: ThemedToken[][] | null;
  source: string;

}

export class Code extends Component<CodeProps, CodeState> {

  state: CodeState = { lines: null, source: "" };

  private token = 0;

  componentDidMount() {

    void this.highlight();

  }

  componentDidUpdate(prev: CodeProps) {

    if (prev.code !== this.props.code || prev.streaming !== this.props.streaming) {

      void this.highlight();

    }

  }

  componentWillUnmount() {

    this.token += 1;

  }

  private async highlight() {

    const { code, lang = "bash", streaming } = this.props;

    if (streaming || !code) {

      return;

    }

    const ticket = (this.token += 1);

    try {

      const { tokens } = await codeToTokens(code, { lang: lang as never, theme: "github-dark-default" });

      if (ticket === this.token) {

        this.setState({ lines: tokens, source: code });

      }

    } catch {

      // unknown grammar — plain text is fine
    }

  }

  render() {

    const { code } = this.props;
    const { lines, source } = this.state;

    if (!lines || source !== code) {

      return <pre className="m-0 w-full font-mono text-xs leading-relaxed whitespace-pre-wrap">{code}</pre>;

    }

    return (

      <pre className="m-0 w-full font-mono text-xs leading-relaxed whitespace-pre-wrap">

        {lines.map((line, index) => (

          <span key={index}>

            {line.map((token, position) => (

              <span key={position} style={{ color: token.color }}>{token.content}</span>

            ))}

            {index < lines.length - 1 && "\n"}

          </span>

        ))}

      </pre>

    );

  }

}
