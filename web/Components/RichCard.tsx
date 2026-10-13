import { Component, type FormEvent, type ReactNode } from "react";

import { CardIcon } from "./CardIcon";
import { Button, Field, inputClass } from "./Controls";
import { Memo } from "./Memo";

import { cardReply, parseCard, type Card, type CardBlock } from "../Lib/card";

function IconRow({ icon, children, className = "", size = 18, inline = false }: { icon?: string; children: ReactNode; className?: string; size?: number; inline?: boolean }) {

  const Tag = inline ? "span" : "div";

  return (

    <Tag className={`flex min-w-0 items-start gap-2.5 ${className}`}>

      {icon && <span className="flex h-[1lh] shrink-0 items-center"><CardIcon name={icon} size={size} /></span>}
      <Tag className="min-w-0 grow">{children}</Tag>

    </Tag>

  );

}

function renderBlock(block: CardBlock, key: number): ReactNode {

  if (block.type === "section" || block.type === "metric" || !block.icon) {

    return renderContent(block, key);

  }

  const alignment = block.type === "text" ? "text-[16px] leading-relaxed" : block.type === "table" ? "text-[14px] [&>span]:mt-2" : "";

  return <IconRow key={key} icon={block.icon} className={alignment}>{renderContent(block, key)}</IconRow>;

}

function renderContent(block: CardBlock, key: number): ReactNode {

  switch (block.type) {

    case "text":

      return <Memo key={key} text={block.text} className="text-[16px]" />;

    case "list":

      return <ul key={key} className="m-0 flex list-disc flex-col gap-1.5 pl-5 marker:text-dim">{block.items.map((item, index) => <li key={index} className="whitespace-pre-wrap">{item}</li>)}</ul>;

    case "table":

      return (

        <div key={key} className="min-w-0 overflow-auto rounded-xl border border-line">

          <table className="w-full border-collapse text-left text-[14px]">

            <thead className="bg-raised text-dim">

              <tr>{block.columns.map((column, index) => <th key={index} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">{column}</th>)}</tr>

            </thead>
            <tbody>

              {block.rows.map((row, index) => <tr key={index} className="border-t border-line">{row.map((cell, column) => <td key={column} className="min-w-24 px-3 py-2 align-top whitespace-pre-wrap">{cell}</td>)}</tr>)}

            </tbody>

          </table>

        </div>

      );

    case "metric":

      return (

        <div key={key} className="flex flex-col gap-1 rounded-xl bg-raised px-4 py-3">

          <IconRow icon={block.icon} size={16} className="text-[13px] leading-normal text-dim">{block.label}</IconRow>
          <span className="font-serif text-[28px] leading-tight">{block.value}</span>
          {block.detail && <span className="text-[13px] text-dim">{block.detail}</span>}

        </div>

      );

    case "image":

      return <img key={key} src={block.url} alt={block.alt} loading="lazy" referrerPolicy="no-referrer" className="max-h-96 max-w-full self-start rounded-xl object-contain" />;

    case "link":

      return <a key={key} href={block.url} target="_blank" rel="noopener noreferrer" className="self-start underline decoration-dim underline-offset-4 hover:decoration-fg">{block.label}</a>;

    case "section":

      return (

        <section key={key} className="flex min-w-0 flex-col gap-3 border-t border-line pt-4">

          {block.title && <h3 className="m-0 text-[15px] leading-snug font-medium"><IconRow inline icon={block.icon}>{block.title}</IconRow></h3>}
          {block.blocks.map((child, index) => renderBlock(!index && !block.title && block.icon && !child.icon ? { ...child, icon: block.icon } : child, index))}

        </section>

      );

  }

}

interface RichCardProps {

  text: string;
  onSend?: (text: string) => Promise<void>;

}

export class RichCard extends Component<RichCardProps, { busy: boolean; note: string }> {

  state = { busy: false, note: "" };

  private source = "";
  private card: Card | null = null;
  private sending = false;

  send = async (text: string) => {

    if (this.sending || !this.props.onSend) {

      return;

    }

    this.sending = true;
    this.setState({ busy: true, note: "" });

    try {

      await this.props.onSend(text);
      this.setState({ note: "Sent" });

    } catch (error) {

      this.setState({ note: error instanceof Error ? error.message : String(error) });

    } finally {

      this.sending = false;
      this.setState({ busy: false });

    }

  };

  submit = (event: FormEvent<HTMLFormElement>) => {

    event.preventDefault();

    const values = new FormData(event.currentTarget);
    const card = this.card!;

    if (card.fields?.some((field) => field.required && !String(values.get(field.name) ?? "").trim())) {

      this.setState({ note: "Complete the required fields." });
      return;

    }

    this.send(cardReply(card, values));

  };

  render() {

    if (this.source !== this.props.text) {

      this.source = this.props.text;
      this.card = parseCard(this.source);

    }

    const card = this.card;
    const disabled = this.state.busy || !this.props.onSend;

    if (!card) {

      return <div className="text-[14px] text-dim">This card could not be displayed.</div>;

    }

    return (

      <section aria-label={card.title || "Card"} className="flex w-full min-w-0 max-w-2xl flex-col gap-4 self-start rounded-2xl bg-panel p-5 text-[15px] wrap-anywhere">

        {(card.title || card.icon) && (

          <h2 className="m-0 font-serif text-[22px] leading-snug">

            <IconRow inline icon={card.icon} size={20}>{card.title}</IconRow>

          </h2>

        )}
        {card.blocks.map(renderBlock)}
        {Boolean(card.actions?.length) && (

          <div className="flex flex-wrap gap-2">

            {card.actions!.map((action, index) => (

              <Button key={index} disabled={disabled} className="flex h-auto min-h-11 items-center gap-2 py-2" onClick={() => this.send(action.reply)}>

                <IconRow inline icon={action.icon}>{action.label}</IconRow>

              </Button>

            ))}

          </div>

        )}
        {Boolean(card.fields?.length) && (

          <form onSubmit={this.submit} className="flex flex-col gap-4">

            {card.fields!.map((field) => (

              <Field key={field.name} label={`${field.label}${field.required ? " *" : ""}`}>

                {field.multiline ? <textarea name={field.name} aria-label={field.label} placeholder={field.placeholder} required={field.required} disabled={disabled} maxLength={4000} rows={3} className={inputClass} /> : <input name={field.name} aria-label={field.label} placeholder={field.placeholder} required={field.required} disabled={disabled} maxLength={4000} className={inputClass} />}

              </Field>

            ))}
            <Button type="submit" tone="primary" disabled={disabled} className="self-start">{card.submit || "Send"}</Button>

          </form>

        )}
        {this.state.note && <span role="status" className="text-[13px] text-dim">{this.state.note}</span>}

      </section>

    );

  }

}
