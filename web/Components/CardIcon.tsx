import { Circle, type LucideIcon } from "lucide-react";
import { Component } from "react";

interface CardIconProps {

  name: string;
  size?: number;

}

export class CardIcon extends Component<CardIconProps, { icon: LucideIcon; name: string }> {

  state = { icon: Circle, name: "" };

  private request = 0;

  componentDidMount() {

    this.load();

  }

  componentDidUpdate(previous: CardIconProps) {

    if (previous.name !== this.props.name) {

      this.load();

    }

  }

  componentWillUnmount() {

    this.request++;

  }

  load = async () => {

    const request = ++this.request;
    const name = this.props.name;
    let icon = Circle;

    try {

      const { default: icons } = await import("lucide-react/dynamicIconImports");

      if (Object.hasOwn(icons, name)) {

        icon = (await icons[name as keyof typeof icons]()).default;

      }

    } catch {

      // A missing cached chunk should not break the card after a deploy.
      icon = Circle;

    }

    if (request === this.request) {

      this.setState({ icon, name });

    }

  };

  render() {

    const Icon = this.state.name === this.props.name ? this.state.icon : Circle;

    return <Icon size={this.props.size ?? 18} strokeWidth={1.6} aria-hidden="true" focusable="false" className="shrink-0 text-dim" />;

  }

}
