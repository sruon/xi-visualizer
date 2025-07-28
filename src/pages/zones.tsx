import { createSignal, Show } from "solid-js";
import LookupInput, { Option } from "../components/lookup_input";
import ZoneComponent from "../components/zone";
import zones, { ZoneInfo } from "../data/zones";
import { useNavigate, useParams } from "@solidjs/router";

export default function ZonesPage() {
  const navigate = useNavigate();
  const params = useParams();

  return (
    <section class="p-8">
      <h1 class="text-2xl font-bold">Zones</h1>
      <LookupInput
        options={zones}
        nameFn={v => v.name}
        autofocus
        onChange={(value: Option<ZoneInfo>) => {
          navigate(`/zone/${value.data.id}`);
        }}
      >
      </LookupInput>

      <Show when={params.id}>
        <ZoneComponent zone={zones[params.id]}></ZoneComponent>
      </Show>
    </section>
  );
}
